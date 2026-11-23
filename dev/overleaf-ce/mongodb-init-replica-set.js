/* eslint-disable no-undef */
// Same as overleaf/overleaf bin/shared/mongodb-init-replica-set.js: Overleaf needs a replica set.
rs.initiate({ _id: 'overleaf', members: [{ _id: 0, host: 'mongo:27017' }] })
