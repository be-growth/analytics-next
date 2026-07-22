---
'@segment/analytics-next': patch
---

fix(conversion-collector): stamp context.app.name and context.library on the always-on native pipeline so app_name and sdk_version reach the collector without enabling context enrichment (AU-165)
