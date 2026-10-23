# Local SQLite schema

The app creates `data/prototype.sqlite3` from `schema/schema.sql` and reapplies its idempotent `CREATE IF NOT EXISTS` statements at startup. There are no migrations. For an explicit demo reset, stop the app and delete only `data/prototype.sqlite3`, then restart. This also removes its audit trail and imported requests.

`email_identities` maps sender + `Message-ID` to a request; its content hash detects reused IDs with changed content. Existing email files are indexed on first import after an upgrade.
