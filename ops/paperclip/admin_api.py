import urllib.request, urllib.error, json, http.cookiejar, pathlib
BASE='https://paperclip.midelim.tech/api/'
ORIGIN='https://paperclip.midelim.tech'
def api(path,body=None,method=None):
    jar=http.cookiejar.LWPCookieJar('/etc/paperclip/admin.cookies')
    jar.load(ignore_discard=True,ignore_expires=True)
    headers={'Host':'paperclip.midelim.tech','Origin':ORIGIN,'Content-Type':'application/json','Cookie':'; '.join(c.name+'='+c.value for c in jar)}
    req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    try:
        with urllib.request.urlopen(req) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        print('API request failed:',path,'HTTP',e.code)
        # Validation messages only; never print credential-bearing response bodies.
        raise SystemExit(1)
