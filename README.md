# Shipper Book hunters

Nightly collectors of **free public data** for Freight Radar, part of Shipper Book (a CRM for freight brokerages).

This repository is public on purpose (public repositories get free GitHub Actions minutes) and holds **collection code only**:

- It reads public open-data sources (FMCSA census, EPA, city permits, SEC EDGAR, news and job boards) and saves what they say, with the source, to one shared pool of public company data.
- It does **no scoring, no matching and no company logic**. Which companies are good leads for which brokerage is decided in the private Shipper Book app.
- It has **no AI** and uses **no paid service**.
- It holds **no secrets**. Keys are GitHub Actions secrets, never files in this repo.

## How it runs

1. The Shipper Book database starts a hunter every night through the GitHub API (`workflow_dispatch` of `hunter.yml`). A watchdog in the database starts it again after a failure.
2. GitHub's own schedule (`30 9 * * *` UTC) is a backup: it runs only the hunters that are due.
3. Every request to a public source goes through one shared limiter (about one a second) with polite retries.
4. Each hunter has a nightly cap, and its progress is recorded in `radar_hunter_runs` so failures are visible.

## The database login

Hunters log in as `radar_hunter`. It can add to and update the shared pool tables and the run log. It has **no access** to any company's leads, shippers, people or settings, and a check in the Shipper Book test suite proves it.

## Secrets (GitHub → Settings → Secrets and variables → Actions)

| Name | What it is |
|---|---|
| `HUNTER_DATABASE_URL` | the `radar_hunter` connection string (never share it) |
| `SOCRATA_APP_TOKEN` | optional, free; raises the limits on data.transportation.gov and city open-data sites |

## Running tests

```
npm ci
npm test
```

## Contact

Requests carry the user agent `ShipperBookHunters/0.1`. The owner can be reached through the Shipper Book project.
