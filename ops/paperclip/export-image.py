#!/usr/bin/env python3
"""Export the already-tested CI image and reviewed controls, without runtime data."""
import argparse, gzip, hashlib, json, pathlib, re, shutil, subprocess
CONTROLS = {
    "codex-pilot": "ops/paperclip/codex-pilot",
    "authorize-packet.py": "ops/paperclip/authorize-packet.py",
    "packet-preflight.py": "scripts/check_task_packets.py",
}
CONTROL_MODES = {"codex-pilot": 0o755, "authorize-packet.py": 0o700, "packet-preflight.py": 0o644}
def sha256(path):
    digest=hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""): digest.update(chunk)
    return digest.hexdigest()
def validate_identity(commit,head,image):
    if not re.fullmatch(r"[0-9a-f]{40}",commit) or head != commit:
        raise ValueError("Export requires the exact checked-out commit")
    labels=image.get("Config",{}).get("Labels",{}) or {}
    if labels.get("org.opencontainers.image.revision") != commit:
        raise ValueError("Image revision does not match the tested commit")
    if labels.get("org.opencontainers.image.source") != "https://github.com/mide-lim/MEGA-BRAIN":
        raise ValueError("Image source label mismatch")
    if image.get("Os") != "linux" or image.get("Architecture") != "amd64":
        raise ValueError("Unexpected image platform")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}",image.get("Id","")):
        raise ValueError("Invalid image ID")
def copy_controls(root, controls):
    controls.mkdir()
    hashes={}
    for name,relative in CONTROLS.items():
        source=root/relative
        if source.is_symlink() or not source.is_file(): raise ValueError("Invalid control source")
        destination=controls/name
        shutil.copyfile(source,destination)
        destination.chmod(CONTROL_MODES[name])
        hashes[name]=sha256(destination)
    return hashes
def export(root,image_name,commit,output):
    head=subprocess.check_output(["git","-C",str(root),"rev-parse","HEAD"],text=True).strip()
    subprocess.run(["git","-C",str(root),"diff","--exit-code","HEAD"],check=True,capture_output=True)
    image=json.loads(subprocess.check_output(["docker","image","inspect",image_name],text=True))[0]
    validate_identity(commit,head,image)
    if output.exists(): raise ValueError("Output directory must not already exist")
    output.mkdir(parents=True)
    hashes=copy_controls(root,output/"controls")
    archive=output/"image.tar.gz"
    with archive.open("xb") as destination:
        process=subprocess.Popen(["docker","save",image_name],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            with gzip.GzipFile(fileobj=destination,mode="wb",mtime=0) as compressed:
                shutil.copyfileobj(process.stdout,compressed,length=1024*1024)
            _,error=process.communicate(timeout=30)
            if process.returncode: raise RuntimeError("Docker export failed")
        finally:
            if process.poll() is None:
                process.kill();process.wait()
    manifest={"format":1,"sourceCommit":commit,"imageId":image["Id"],"imageTag":image_name,"platform":"linux/amd64","archive":"image.tar.gz","archiveSha256":sha256(archive),"controls":hashes,"controlModes":{name:format(mode,"04o") for name,mode in CONTROL_MODES.items()}}
    (output/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    print("Exported tested image and controls for "+commit)
if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image",default="paperclip-control-candidate")
    parser.add_argument("--commit",required=True)
    parser.add_argument("--output",type=pathlib.Path,required=True)
    args=parser.parse_args()
    export(pathlib.Path(__file__).resolve().parents[2],args.image,args.commit,args.output.resolve())
