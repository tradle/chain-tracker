
# Usage

```js
var level = require('level')
var Blockchain = require('cb-blockr') // or some other common-blockchain implementation
var createTracker = require('chain-tracker')
var db = level('./chain-tracker.db', { valueEncoding: 'json' })
var net = 'testnet'
var tracker = createTracker({
  networkName: net,
  blockchain: new Blockchain(net),
  db: db
})

// add addresses to watch
tracker.watchAddresses(['mucvYPyF36YUbjVd3UzZaxrtU4LhJzf8fs'])

// sync
tracker.sync(function () {
  // get stored transactions for a particular address
  tracker.getTxs(addr1, function (err, txInfos) {
    // ...
  })
})

// or subscribe to events
tracker.on('sync', function (updatedAddrs) {
  // ...
})
```
