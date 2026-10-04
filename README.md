# actual-bank-sync

Runs the bank sync of a self-hosted [Actual Budget](https://actualbudget.org) on a schedule and reports
each run to Home Assistant over MQTT discovery.

## What it does

- At each `SYNC_AT` time, and whenever the `Sync now` button is pressed, it downloads the budget and runs
  the bank sync for every open account, retrying a failing account before giving up on it. Accounts
  without a bank link are skipped by Actual itself.
- Each run happens in a child process with a time limit. The Actual engine holds the whole budget in
  memory and can leave stray promise rejections behind; both end with the child, and the service keeps
  running.
- The Actual API package must match the server's version: a mismatched client fails right after login.
  Before each run the service reads the server's version and installs that API release into the data
  dir once, so an upgraded server needs no new image. `ACTUAL_API_VERSION` pins one instead.

## Entities

One device, `Actual Bank Sync` unless `DEVICE_NAME` says otherwise; the name sets the ids.

| Entity | Meaning |
|---|---|
| `sensor …_status` | `idle`, `running`, `success`, `partial` (some accounts failed) or `error`; the attributes list each account's result, the error, the API and server versions and the run time |
| `binary_sensor …_problem` | On when the last run was not a full success |
| `sensor …_last_sync` | When the last fully successful run finished |
| `sensor …_next_sync` | The next scheduled run |
| `button …_sync_now` | Starts a run |

The state is retained on `actual-bank-sync/<slug>/state`, so a restart keeps the last outcome.
`actual-bank-sync/<slug>/availability` is the last will.

## Configuration

| Variable | Default | |
|---|---|---|
| `ACTUAL_SERVER_URL` | | The Actual server |
| `ACTUAL_PASSWORD` or `ACTUAL_SESSION_TOKEN` | | Server login |
| `ACTUAL_BUDGET_ID` | | The budget's sync id (Settings → Advanced) |
| `ACTUAL_BUDGET_PASSWORD` | | For an end-to-end encrypted budget |
| `ACTUAL_API_VERSION` | the server's | Pins the API release |
| `SYNC_AT` | `06:00` | Comma-separated local times; empty for button only |
| `TZ` | `UTC` | Time zone of `SYNC_AT` |
| `SYNC_RETRIES` | `3` | Attempts per account |
| `SYNC_TIMEOUT_MIN` | `15` | Time limit of one run |
| `MQTT_URL` | | e.g. `mqtt://broker:1883` |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | | |
| `DEVICE_NAME` | `Actual Bank Sync` | |
| `MQTT_PREFIX` | `actual-bank-sync/<slug>` | |
| `DISCOVERY_PREFIX` | `homeassistant` | |
| `DATA_DIR` | `/data` | Budget cache and installed API releases |

## Running

```sh
docker compose up -d --build
```

Without Docker: `npm ci` and `npm start` with the environment above (Node 22 or newer). Tests: `npm test`.
