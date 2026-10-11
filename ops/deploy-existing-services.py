"""Manual, image-only updates for reviewed existing Cloud Run services."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

KINDS = ("worker", "web")


class DeploymentError(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def service_view(service):
    template = copy.deepcopy(service["template"])
    template.pop("revision", None)
    return {
        "template": template,
        "traffic": service.get("traffic", []),
        "ingress": service.get("ingress"),
        "scaling": service.get("scaling"),
        "invokerIamDisabled": service.get("invokerIamDisabled", False),
        "defaultUriDisabled": service.get("defaultUriDisabled", False),
        "iapEnabled": service.get("iapEnabled", False),
        "customAudiences": service.get("customAudiences", []),
        "binaryAuthorization": service.get("binaryAuthorization"),
    }


def baseline_digest(services):
    return hashlib.sha256(canonical({k: service_view(services[k]) for k in KINDS}).encode()).hexdigest()


def without_image(service):
    view = service_view(service)
    for container in view["template"]["containers"]:
        container.pop("image", None)
    return view


def validate_config(config):
    identifiers = [config["project"], config["region"], config["queue"], *config["services"].values()]
    if set(config["services"]) != set(KINDS) or set(config["runtime_accounts"]) != set(KINDS):
        raise DeploymentError("Unexpected service mapping")
    if any(not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", item) for item in identifiers):
        raise DeploymentError("Invalid resource identifier")
    expected_registry = config["region"] + "-docker.pkg.dev/" + config["project"] + "/"
    if not config["registry"].startswith(expected_registry) or not re.fullmatch(r"[a-z0-9-]+", config["registry"].split("/")[-1]):
        raise DeploymentError("Registry outside configured project")
    if len(set(config["services"].values())) != 2:
        raise DeploymentError("Services must be distinct")
    if any(not value.endswith("@" + config["project"] + ".iam.gserviceaccount.com") for value in config["runtime_accounts"].values()):
        raise DeploymentError("Runtime identity outside configured project")


def validate_services(services, config):
    for kind in KINDS:
        service = services[kind]
        template = service["template"]
        if service.get("reconciling") or service.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED":
            raise DeploymentError("Service not ready")
        if template.get("serviceAccount") != config["runtime_accounts"][kind]:
            raise DeploymentError("Runtime identity changed")
        if template.get("scaling", {}).get("maxInstanceCount") != 1 or len(template["containers"]) != 1:
            raise DeploymentError("Runtime limits changed")
        if service.get("traffic") != [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100}]:
            raise DeploymentError("Unsupported traffic policy")
        image = template["containers"][0]["image"]
        if not image.startswith(config["registry"] + "/" + kind + "@sha256:") or not re.fullmatch(r".+@sha256:[a-f0-9]{64}", image):
            raise DeploymentError("Current image not pinned in configured registry")
        for volume in template.get("volumes", []):
            for item in volume.get("secret", {}).get("items", []):
                if not str(item.get("version", "")).isdigit():
                    raise DeploymentError("Secret volume version must be pinned")
        for env in template["containers"][0].get("env", []):
            secret = env.get("valueSource", {}).get("secretKeyRef")
            if secret and not str(secret.get("version", "")).isdigit():
                raise DeploymentError("Environment secret version must be pinned")


class Google:
    def __init__(self, config, token):
        self.config = config
        self.token = token
        self.prefix = "https://run.googleapis.com/v2/projects/" + config["project"] + "/locations/" + config["region"]

    def request(self, method, url, body=None):
        data = None if body is None else canonical(body).encode()
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Never echo remote messages, URLs, configurations, or tokens into public CI.
            raise DeploymentError("Google request failed: HTTP " + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError):
            raise DeploymentError("Google request failed: transport error") from None

    def service(self, kind):
        return self.request("GET", self.prefix + "/services/" + self.config["services"][kind])

    def paused(self):
        url = "https://cloudtasks.googleapis.com/v2/projects/" + self.config["project"] + "/locations/" + self.config["region"] + "/queues/" + self.config["queue"]
        if self.request("GET", url).get("state") != "PAUSED":
            raise DeploymentError("Paused processing queue required")

    def update(self, kind, current, containers, validate_only=False):
        url = self.prefix + "/services/" + self.config["services"][kind] + "?updateMask=template.containers"
        if validate_only:
            url += "&validateOnly=true"
        body = {"name": current["name"], "etag": current["etag"], "template": {"containers": containers}}
        operation = self.request("PATCH", url, body)
        if validate_only:
            # Cloud Run validates without persisting this operation; do not poll it.
            if operation.get("error"):
                raise DeploymentError("Cloud Run validation failed")
            return
        if operation.get("done"):
            if operation.get("error"):
                raise DeploymentError("Cloud Run validation or update failed")
            return
        name = operation.get("name", "")
        if not name.startswith(self.prefix.removeprefix("https://run.googleapis.com/v2/") + "/operations/"):
            raise DeploymentError("Unexpected operation scope")
        for _ in range(120):
            result = self.request("GET", "https://run.googleapis.com/v2/" + name)
            if result.get("done"):
                if result.get("error"):
                    raise DeploymentError("Cloud Run update failed")
                return
            time.sleep(2)
        raise DeploymentError("Cloud Run update timeout; inspect before another attempt")


def command(args, input_text=None):
    result = subprocess.run(args, input=input_text, text=True, capture_output=True, check=False)
    if result.returncode:
        raise DeploymentError("Image publication command failed")
    return result.stdout


def publish(config, token, commit):
    images = {}
    with tempfile.TemporaryDirectory(prefix="megabrain-registry-") as directory:
        os.chmod(directory, 0o700)
        command(["docker", "--config", directory, "login", config["region"] + "-docker.pkg.dev",
                 "--username", "oauth2accesstoken", "--password-stdin"], token)
        for kind in KINDS:
            local = "megabrain-" + kind + ":ci"
            inspected = json.loads(command(["docker", "image", "inspect", local]))[0]
            if inspected["Config"].get("Labels", {}).get("org.opencontainers.image.revision") != commit:
                raise DeploymentError("Candidate source revision mismatch")
            tag = config["registry"] + "/" + kind + ":git-" + commit
            command(["docker", "tag", local, tag])
            command(["docker", "--config", directory, "push", tag])
            digests = json.loads(command(["docker", "image", "inspect", tag]))[0].get("RepoDigests", [])
            images[kind] = next((d for d in digests if re.fullmatch(re.escape(config["registry"] + "/" + kind) + r"@sha256:[a-f0-9]{64}", d)), None)
            if not images[kind]:
                raise DeploymentError("Published registry digest missing")
    return images


def smoke_web(origin):
    # Only anonymous GETs; no import, processing, OAuth exchange, or model calls.
    if not re.fullmatch(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app", origin):
        raise DeploymentError("Unexpected service origin")
    def read(path, expected):
        try:
            with urllib.request.urlopen(origin + path, timeout=30) as response:
                status, data = response.status, response.read(2_000_000).decode("utf-8")
        except urllib.error.HTTPError as error:
            status, data = error.code, ""
        if status != expected:
            raise DeploymentError("Anonymous route verification failed")
        return data
    html = read("/", 200)
    if "Entrar com Google" not in html:
        raise DeploymentError("Login page verification failed")
    css = re.search(r'href="([^"]+\.css[^"]*)"', html)
    if not css or not css[1].startswith("/") or css[1].startswith("//"):
        raise DeploymentError("Stylesheet verification failed")
    read(css[1], 200)
    for path in ["/api/library", "/api/controls", "/api/financial", "/api/video/AbCdE123"]:
        read(path, 401)
    read("/auth/callback?state=invalid&code=invalid", 403)


def rollout(api, config, originals, images, smoke=smoke_web):
    changed = []
    try:
        for kind in KINDS:
            api.paused()
            current = api.service(kind)
            if service_view(current) != service_view(originals[kind]):
                raise DeploymentError("Reviewed service changed before update")
            containers = copy.deepcopy(current["template"]["containers"])
            containers[0]["image"] = images[kind]
            # Register before sending: a timed-out PATCH might have applied.
            changed.append(kind)
            api.update(kind, current, containers)
            deployed = api.service(kind)
            if deployed["template"]["containers"][0]["image"] != images[kind] or without_image(deployed) != without_image(originals[kind]):
                raise DeploymentError("Updated service differs from reviewed configuration")
            if deployed.get("reconciling") or deployed.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED":
                raise DeploymentError("Updated service not ready")
        smoke(api.service("web")["uri"])
        api.paused()
    except Exception as error:
        rollback_errors = []
        for kind in reversed(changed):
            try:
                current = api.service(kind)
                if current.get("reconciling"):
                    raise DeploymentError("Operation still reconciling; manual recovery required")
                current_image = current["template"]["containers"][0]["image"]
                old_image = originals[kind]["template"]["containers"][0]["image"]
                if current_image == old_image:
                    continue
                if current_image != images[kind] or without_image(current) != without_image(originals[kind]):
                    raise DeploymentError("Concurrent change; automatic recovery refused")
                api.update(kind, current, copy.deepcopy(originals[kind]["template"]["containers"]))
                restored = api.service(kind)
                if service_view(restored) != service_view(originals[kind]) or restored.get("terminalCondition", {}).get("state") != "CONDITION_SUCCEEDED":
                    raise DeploymentError("Recovery not confirmed")
            except Exception:
                rollback_errors.append(kind)
        if rollback_errors:
            raise DeploymentError("Deployment failed; recovery needs operator review") from None
        raise DeploymentError("Deployment failed; previous images preserved or restored") from error


def run(mode, config, commit, expected_baseline, token):
    validate_config(config)
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[a-f0-9]{64}", expected_baseline):
        raise DeploymentError("Commit and reviewed baseline are required")
    api = Google(config, token)
    api.paused()
    originals = {k: api.service(k) for k in KINDS}
    validate_services(originals, config)
    if baseline_digest(originals) != expected_baseline:
        raise DeploymentError("Production differs from the reviewed baseline")
    for kind in KINDS:
        api.update(kind, originals[kind], originals[kind]["template"]["containers"], validate_only=True)
    if mode == "review":
        return {"commit": commit, "status": "review_passed", "deployed": False}
    images = publish(config, token, commit)
    # Re-read and validate after publication to reject concurrent edits.
    api.paused()
    if baseline_digest({k: api.service(k) for k in KINDS}) != expected_baseline:
        raise DeploymentError("Production changed during image publication")
    rollout(api, config, originals, images)
    return {"commit": commit, "status": "deployed_and_checked", "deployed": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["review", "deploy"], required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        config = json.loads(os.environ["MEGABRAIN_DEPLOY_CONFIG"])
        token = os.environ["GOOGLE_ACCESS_TOKEN"]
        outcome = run(args.mode, config, args.commit, args.baseline, token)
        Path(args.output).write_text(json.dumps(outcome, indent=2) + "\n")
        print(outcome["status"])
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        # A traceback can disclose paths, resource identifiers, config, or tokens.
        print("Manual deployment did not complete. Review the protected operation state before retrying.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
