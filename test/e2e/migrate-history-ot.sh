#!/bin/sh
# Switches a project in the dev Overleaf CE to history-ot documents (Overleaf has the migration but no route
# for it). Used by the e2e test; the project must have no connected editors. Usage: migrate-history-ot.sh <projectId>
exec docker exec -w /overleaf/services/web "${OLR_DEV_CONTAINER:-olr-overleaf-ce-sharelatex-1}" \
  node --input-type=module -e "
    const { advanceOTMigrationStage } = await import('/overleaf/services/web/app/src/Features/History/HistoryOTMigration.mjs')
    console.log(JSON.stringify(await advanceOTMigrationStage('$1', 1)))
    process.exit(0)
  "
