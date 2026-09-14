"""Apply only the two keeper service settings; never reads/writes service secrets.

New Railway services stopped accepting railway.toml on 2026-08-28. This uses
the documented GraphQL API with existing local Railway CLI authentication.
Default is a reviewable dry-run. Run with --apply to save the settings, then
redeploy each service. The frontend and other project services are untouched.
"""
import argparse
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
configuration = json.loads((pathlib.Path(__file__).resolve().parent.parent / "railway-services.json").read_text())
if not args.apply:
    print(json.dumps(configuration, indent=2))
    raise SystemExit(0)

user = json.loads((pathlib.Path.home() / ".railway/config.json").read_text())["user"]
token = user.get("accessToken") or user["token"]
query = """mutation Update($environmentId:String!,$serviceId:String!,$input:ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(environmentId:$environmentId,serviceId:$serviceId,input:$input)
}"""
for service in configuration["services"]:
    payload = json.dumps({"query": query, "variables": {
        "environmentId": configuration["environmentId"], "serviceId": service["id"], "input": service["settings"]
    }})
    curl_config = ('url = "https://backboard.railway.com/graphql/v2"\n'
                   'header = "Content-Type: application/json"\n'
                   f'header = "Authorization: Bearer {token}"\n'
                   f'data = {json.dumps(payload)}\n')
    result = subprocess.run(["curl", "--max-time", "20", "-sS", "--config", "-"], input=curl_config, capture_output=True, text=True, check=True)
    response = json.loads(result.stdout)
    if response.get("errors") or response.get("data", {}).get("serviceInstanceUpdate") is not True:
        raise SystemExit(f"Could not update {service['name']}; inspect its Railway settings before retrying.")
    print(f"Updated runtime settings: {service['name']}")

for backup in configuration.get("backups", []):
    payload = json.dumps({"query": """mutation Schedule($id:String!,$kinds:[VolumeInstanceBackupScheduleKind!]!) {
      volumeInstanceBackupScheduleUpdate(volumeInstanceId:$id,kinds:$kinds)
    }""", "variables": {"id": backup["volumeInstanceId"], "kinds": backup["kinds"]}})
    curl_config = ('url = "https://backboard.railway.com/graphql/v2"\n'
                   'header = "Content-Type: application/json"\n'
                   f'header = "Authorization: Bearer {token}"\n'
                   f'data = {json.dumps(payload)}\n')
    result = subprocess.run(["curl", "--max-time", "20", "-sS", "--config", "-"], input=curl_config, capture_output=True, text=True, check=True)
    response = json.loads(result.stdout)
    if response.get("errors") or response.get("data", {}).get("volumeInstanceBackupScheduleUpdate") is not True:
        raise SystemExit(f"Could not schedule backups for {backup['name']}; inspect Railway before retrying.")
    print(f"Scheduled daily and weekly backups: {backup['name']}")
