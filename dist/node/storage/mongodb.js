const EventEmitter = require('events')
const mongoose = require('mongoose')
const HashHelper = require('../../common/hash-helper')
const Logger = require('../../common/logger')

/**
 * @class MongodbStorage
 * @param {object} options
 * @param {boolean} options.connectOnInit
 * @param {string} options.connectionString
 * @param {object} options.collectionNames
 * @param {string} options.collectionNames.blocks
 * @param {string} options.collectionNames.transactions
 * @param {string} options.collectionNames.addresses
 * @param {object} options.loggerOptions
 */
class MongodbStorage extends EventEmitter {
  /**
   * @fires MongodbStorage#constructor:complete
   */
  constructor (options = {}) {
    super()

    // -- Properties
    /** @type {object} */
    this.blockModel = undefined
    /** @type {object} */
    this.transactionModel = undefined
    /** @type {object} */
    this.addressModel = undefined
    /** @type {object} */
    this.logger = undefined
    /** @type {object} */
    this.defaultOptions = {
      connectOnInit: true,
      connectionString: 'mongodb://localhost/neo',
      collectionNames: {
        blocks: 'b_neo_t_blocks',
        transactions: 'b_neo_t_transactions',
        addresses: 'b_neo_t_addresses'
      },
      loggerOptions: {}
    }

    // -- Bootstrap
    Object.assign(this, this.defaultOptions, options)
    this.logger = new Logger('MongodbStorage', this.loggerOptions)
    this.blockModel = this.getBlockModel()
    this.transactionModel = this.getTransactionModel()
    this.addressModel = this.getAddressModel()

    mongoose.Promise = global.Promise // Explicitly supply promise library (http://mongoosejs.com/docs/promises.html)
    this.initConnection()
    /**
     * @event MongodbStorage#constructor:complete
     * @type {object}
     */
    this.emit('constructor:complete')
  }

  /**
   * @private
   * @returns {void}
   */
  initConnection () {
    this.logger.debug('initConnection triggered.')
    if (this.connectOnInit) {
      mongoose.connect(this.connectionString, { useMongoClient: true }, (error, connection) => {
        if (!connection) {
          this.logger.error('Unable to established connection. error:', error)
        } else {
          connection.onOpen()
        }
      })
        .then(() => {
          this.logger.info('mongoose connected.')
        })
        .catch((err) => {
          this.logger.error('Error establish MongoDB connection.')
          throw new Error(err.message)
        })
    }
  }

  /**
   * @static
   * @private
   * @param {object} block
   * @returns {object}
   */
  delintBlock (block) {
    this.logger.debug('delintBlock triggered.')
    block.hash = HashHelper.normalize(block.hash)
    block.previousblockhash = HashHelper.normalize(block.previousblockhash)
    block.merkleroot = HashHelper.normalize(block.merkleroot)
    block.tx.forEach((tx) => {
      tx.txid = HashHelper.normalize(tx.txid)
      tx.sys_fee = parseFloat(tx.sys_fee)
      tx.net_fee = parseFloat(tx.net_fee)

      tx.vout.forEach((vout) => {
        vout.asset = HashHelper.normalize(vout.asset)
        vout.value = parseFloat(vout.value)
      })
    })
    return block
  }

  /**
   * @public
   * @param {string} txid
   * @returns {Promise.<object>}
   */
  getTX (txid) {
    this.logger.debug('getTX triggered. txid:', txid)
    return new Promise((resolve, reject) => {
      this.transactionModel.findOne({ txid })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('transactionModel.findOne() execution failed. txid:', txid)
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * List transactions of a specific wallet.
   * @public
   * @param {string} address
   * @returns {Promise.<object>}
   */
  getTransactions (address) {
    this.logger.debug('getTransactions triggered. address:', address)
    return new Promise((resolve, reject) => {
      this.transactionModel.find({
        'vout.address': address,
        $or: [
          {type: 'ContractTransaction'},
          {type: 'InvocationTransaction'},
          {type: 'ClaimTransaction'}
        ]
      })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('transactionModel.find() execution failed. address:', address)
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @param {number} index
   * @returns {Promise.<object>}
   */
  getBlock (index) {
    this.logger.debug('getBlock triggered. index:', index)
    return new Promise((resolve, reject) => {
      this.blockModel.findOne({ index })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('blockModel.findOne() execution failed. index:', index)
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @param {string} hash
   * @returns {Promise.<object>}
   */
  getBlockByHash (hash) {
    this.logger.debug('getBlockByHash triggered. hash:', hash)
    return new Promise((resolve, reject) => {
      this.blockModel.findOne({ hash })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('blockModel.findOne() execution failed. hash:', hash)
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @returns {Promise.<Number>}
   */
  getBlockCount () {
    this.logger.debug('getBlockCount triggered.')
    return new Promise((resolve, reject) => {
      this.blockModel.findOne({}, 'index')
        .sort({ index: -1 })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('blockModel.findOne() execution failed.')
            reject(err)
          }
          if (!res) {
            this.logger.info('blockModel.findOne() executed by without response data.')
            res = { index: -1 }
          }
          const height = res.index + 1
          resolve(height)
        })
    })
  }

  /**
   * @public
   * @returns {Promise.<String>}
   */
  getBestBlockHash () {
    this.logger.debug('getBestBlockHash triggered.')
    return new Promise((resolve, reject) => {
      this.blockModel.findOne({}, 'hash')
        .sort({ index: -1 })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('blockModel.findOne() execution failed.')
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @param {string} hash
   * @returns {Promise.<object>}
   */
  getAsset (hash) {
    this.logger.debug('getAsset triggered. hash:', hash)
    return new Promise((resolve, reject) => {
      this.addressModel.findOne({ type: 'a', address: hash })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('addressModel.findOne() execution failed. hash:', hash)
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @returns {Promise.<Array>}
   */
  getAssetList () {
    this.logger.debug('getAssetList triggered.')
    return new Promise((resolve, reject) => {
      this.addressModel.find({ type: 'a' })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('addressModel.find() execution failed.')
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @param {string} address
   * @param {string} assetHash
   * @param {number} [startBlock = 0]
   * @returns {Promise.<Array>}
   */
  getAssetListByAddress (address, assetHash, startBlock = 0) {
    this.logger.debug('getAssetListByAddress triggered. address:', address, 'assetHash:', assetHash, 'startBlock:', startBlock)
    return new Promise((resolve, reject) => {
      this.transactionModel.find({
        $and: [
          {
            $or: [
              {'vout.address': address},
              {'vin.address': address}
            ]
          },
          {
            $or: [
              {type: 'ContractTransaction'},
              {type: 'InvocationTransaction'},
              {type: 'ClaimTransaction'}
            ]
          }
        ],
        'vout.asset': assetHash,
        blockIndex: { $gte: startBlock }
      })
        .sort('blockIndex')
        .exec((err, res) => {
          if (err) {
            this.logger.warn('transactionModel.find() execution failed. address:', address)
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @param {object} asset
   * @returns {Promise}
   */
  saveAsset (asset) {
    this.logger.debug('saveAsset triggered.')
    return new Promise((resolve, reject) => {
      this.addressModel(asset).save((err) => {
        if (err) {
          this.logger.warn('addressModel().save() execution failed.')
          reject(err)
        }
        resolve()
      })
    })
  }

  /**
   * @public
   * @param {object} block
   * @returns {Promise}
   */
  saveBlock (block) {
    this.logger.debug('saveBlock triggered.')
    return new Promise((resolve, reject) => {
      block = this.delintBlock(block)
      this.blockModel(block).save((err) => {
        if (err) {
          this.logger.warn('blockModel().save() execution failed.')
          reject(err)
        }
        resolve()
      })
    })
  }

  /**
   * @public
   * @param {string} hash
   * @param {object} assetState
   * @returns {Promise}
   */
  saveAssetState (hash, assetState) {
    this.logger.debug('saveAssetState triggered.')
    return new Promise((resolve, reject) => {
      this.getAsset(hash)
        .then((res) => {
          res.state = assetState
          this.addressModel(res).save((err) => {
            if (err) {
              this.logger.warn('addressModel().save() execution failed.')
              reject(err)
            }
            resolve()
          })
        })
        .catch((err) => {
          this.logger.warn('getAsset() execution failed. hash:', hash)
          reject(err)
        })
    })
  }

  /**
   * @public
   * @param {object} tx
   * @returns {Promise}
   */
  saveTransaction (tx) {
    this.logger.debug('saveTransaction triggered.')
    return new Promise((resolve, reject) => {
      this.transactionModel(tx).save((err) => {
        if (err) {
          this.logger.warn('transactionModel().save() execution failed.')
          reject(err)
        }
        resolve()
      })
    })
  }

  /**
   * @public
   * @param {object} tx
   * @returns {Promise}
   */
  updateTransaction (tx) {
    this.logger.debug('updateTransaction triggered.')
    return new Promise((resolve, reject) => {
      this.transactionModel.update({ txid: tx.txid }, tx, (err) => {
        if (err) {
          this.logger.warn('transactionModel().update() execution failed.')
          reject(err)
        }
        resolve()
      })
    })
  }

  /**
   * @public
   * @param {string} hash
   * @returns {Promise.<object>}
   */
  getAddress (hash) {
    this.logger.debug('getAddress triggered. hash:', hash)
    return new Promise((resolve, reject) => {
      this.addressModel.findOne({ address: hash })
        .exec((err, res) => {
          if (err) {
            this.logger.warn('addressModel.findOne() execution failed. hash:', hash)
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @param {object} address
   * @returns {Promise.<object>}
   */
  saveAddress (address) {
    this.logger.debug('saveAddress triggered.')
    return new Promise((resolve, reject) => {
      this.addressModel(address)
        .save((err, res) => {
          if (err) {
            this.logger.warn('addressModel().save() execution failed.')
            reject(err)
          }
          resolve(res)
        })
    })
  }

  /**
   * @public
   * @param {string} addressHash
   * @param {string} assetHash
   * @param {number} balance
   * @param {number} index
   * @returns {Promise.<object>}
   */
  updateBalance (addressHash, assetHash, balance, index) {
    this.logger.debug('updateBalance triggered. addressHash:', addressHash, 'assetHash:', assetHash, 'balance:', balance, 'index:', index)
    return new Promise((resolve, reject) => {
      this.addressModel.update({ address: addressHash, 'assets.asset': assetHash }, {
        'assets.$.balance': balance,
        'assets.$.index': index
      }).exec((err, res) => {
        if (err) {
          this.logger.warn('addressModel.update() execution failed.')
          reject(err)
        }

        if (res.n === 0) {
          const result = { asset: assetHash, balance: balance, index: index, type: 'a' }
          this.addressModel.update({ address: addressHash }, { $push: {assets: result} })
            .exec((err, res) => { // Resolve anyway
              if (err) {
                this.logger.info('addressModel.update() execution failed. continue anyway...')
              }
              resolve(res)
            })
        } else {
          resolve(res)
        }
      })
    })
  }

  /**
   * Verifies local blockchain integrity over a block range.
   * @public
   * @param {string} start - The start index of the block range to verify.
   * @param {number} end - The end index of the block range to verify.
   * @returns {Promise.<Array>} An array containing the indices of the missing blocks.
   */
  verifyBlocks (start, end) {
    this.logger.debug('verifyBlocks triggered. start:', start, 'end:', end)
    return new Promise((resolve, reject) => {
      let missing = []
      let pointer = start - 1

      this.logger.info('Blockchain Verification: Scanning')

      let stream = this.blockModel
        .find({ index: { $gte: start, $lte: end } }, 'index').sort('index')
        .cursor()

      stream.on('data', (d) => {
        while (true) {
          pointer++
          if (d.index === pointer) {
            break
          } else {
            missing.push(pointer)
          }
        }
      })
      stream.on('end', () => {
        resolve(missing)
      })
    })
  }

  /**
   * Verifies local blockchain integrity over assets.
   * @public
   * @returns {Promise.<Array>} An array containing the indices of the invalid assets.
   */
  verifyAssets () {
    this.logger.debug('verifyAssets triggered.')
    return new Promise((resolve, reject) => {
      let missing = []
      let stream = this.addressModel
        .find({ type: 'a' }, 'address state')
        .cursor()

      stream.on('data', (d) => {
        if (!d.state) {
          missing.push(d.address)
        }
      })
      stream.on('end', () => {
        resolve(missing)
      })
    })
  }

  /**
   * @private
   * @returns {object}
   */
  getBlockModel () {
    const schema = new mongoose.Schema({
      hash: String,
      size: Number,
      version: Number,
      previousblockhash: String,
      merkleroot: String,
      time: Number,
      index: {type: 'Number', unique: true, required: true, dropDups: true},
      nonce: String,
      nextconsensus: String,
      script: {
        invocation: String,
        verification: String
      },
      tx: [],
      confirmations: Number,
      nextblockhash: String
    })

    return mongoose.models[this.collectionNames.blocks] || mongoose.model(this.collectionNames.blocks, schema)
  }

  /**
   * @private
   * @returns {object}
   */
  getTransactionModel () {
    const schema = new mongoose.Schema({
      txid: { type: 'String', unique: true, required: true, dropDups: true, index: true },
      size: Number,
      type: { type: 'String', index: true },
      version: Number,
      time: Number,
      attributes: [],
      vin: [],
      vout: [],
      sys_fee: Number,
      net_fee: Number,
      blockIndex: { type: 'Number', index: true },
      scripts: [],
      script: String
    })

    return mongoose.models[this.collectionNames.transactions] || mongoose.model(this.collectionNames.transactions, schema)
  }

  /**
   * @private
   * @returns {object}
   */
  getAddressModel () {
    const schema = new mongoose.Schema({
      address: { type: 'String', unique: true, required: true, dropDups: true },
      asset: 'String',
      type: 'String',
      assets: [],
      history: [],
      state: mongoose.Schema.Types.Mixed
    })

    return mongoose.models[this.collectionNames.addresses] || mongoose.model(this.collectionNames.addresses, schema)
  }
}

module.exports = MongodbStorage
