import RpcEngine from 'rpc-engine'
import hex from 'hex-transcoder'
import utf8 from 'utf8-transcoder'
import Deferred from 'deferred'

class WalletConnect extends RpcEngine {
  constructor (opts) {
    super()
    this.crypto = opts.crypto || window.crypto
    this.id = opts.id || Math.random().toString().slice(2)
    this.meta = opts.meta || {
      name: 'Wallet Connect',
      description: 'Protocol testing',
      url: 'http://localhost:8080',
      icons: []
    }
    this.chainId = opts.chainId || null
    this.rpcUrl = opts.rpcUrl || null
    this.accounts = opts.accounts || null
    this.peerId = opts.peerId || null
    this.peerMeta = opts.peerMeta || null
    this.peerAccounts = opts.peerAccounts || []
    this.peerRequests = opts.peerRequests || []
    this.requests = opts.requests || []
    this.bridgeUrl = opts.bridgeUrl || 'https://bridge.walletconnect.org'
    if (opts.uri) {
      this.uri = opts.uri
    } else {
      this.initiator = opts.initiator === false ? false : true
      this.handshakeId = opts.handshakeId || Math.random().toString().slice(2)
      this.version = opts.version || '1'
      this.bridge = opts.bridge || `${this.bridgeUrl.replace(/^http/, 'ws')}/?env=browser&protocol=wc&version=${this.version}&host=${this.meta && this.meta.host || 'localhost:8080'}`
      this.key = opts.key || this.crypto.getRandomValues(new Uint8Array(32))
    }
    this.onbridgeClose = this.onbridgeClose.bind(this)
    this.receive = this.receive.bind(this)
  }
  
  set uri (uri) {
    let parts = uri.split('@')
    this.handshakeId = parts[0].slice(3)
    this.version = parts[1].split('?')[0]
    this.bridge = decodeURIComponent(uri.split('bridge=')[1].split('&')[0]).replace(/^http/, 'ws')
    this.key = hex.decode(uri.split('key=')[1])
  }

  get uri () {
    const bridgeUrl = encodeURIComponent(this.bridge.replace(/^ws/, 'http'))
    return `wc:${this.handshakeId}@${this.version}?bridge=${bridgeUrl}&key=${hex.encode(this.key)}`
  }

  get session () {
    return {
      id: this.id,
      peerId: this.peerId,
      peerMeta: this.peerMeta,
      chainId: this.chainId,
      accounts: this.accounts,
      requests: this.requests,
      peerAccounts: this.peerAccounts,
      peerRequests: this.peerRequests,
      handshakeId: this.handshakeId,
      initiator: this.initiator,
      version: this.version,
      bridge: this.bridge,
      key: this.key,
    }
  }

  get requests () {
    return this._requests
  }

  set requests (requests) {
    this._requests = requests
    this._requests.forEach(request => {
      if (request.d) return
      if (request.error || request.result !== undefined) return
      request.d = this.callbacks[request.id] = new Deferred()
      request.d.then(result => {
        request.result = result === undefined ? null : result
      }).catch(err => {
        request.error = err  
      }).finally(() => {
        delete request.d
        this.dispatchEvent(new Event('sessionUpdate'))
      })
    })
  }

  get peerRequests () {
    return this._peerRequests
  }

  set peerRequests (requests) {
    this._peerRequests = requests
    this._peerRequests.forEach(request => {
      if (request.d) return
      request.d = new Deferred()
      if (request.id !== this.currentRequestId) {
        request.d.then(userInput => {
          this._send({ id: request.id, result: userInput })
        }).catch(err => {
          this._sendError(err, request.id)
        })
      }
    })
  }

  get approved () {
    return !!this.defaultMethod
  }

  async createSession () {
    try {
      await this.send({ topic: this.id, type: 'sub', silent: true, payload: '' })
      if (this.initiator) {
        // dap
        const result = await this.call('wc_sessionRequest', {
          peerId: this.id,
          peerMeta: this.meta,
          chainId: this.chainId,
          rpcUrl: this.rpcUrl
        })
        if (!result.peerId) throw new Error('session missing peerId')
        if (!result.peerMeta) throw new Error('session missing peerMeta')
        this.peerId = result.peerId
        this.peerMeta = result.peerMeta
        this.chainId = result.chainId || this.chainId
        this.rpcUrl = result.rpcUrl
        this.peerAccounts = result.accounts || []
        this.methods.wc_sessionUpdate = this.updateSession
        this.defaultMethod = this.makePeerRequest
      } else {
        // wallet
        this.methods.wc_sessionRequest = this.requestSession
        await this.send({ topic: this.handshakeId, type: 'sub', silent: true, payload: '' })
        const d = this.onapproveSession = new Deferred()
        return d
      }
    } catch (err) {
      this.destroySession(err)
      throw err
    }
  }

  async resumeSession () {
    this.methods.wc_sessionUpdate = this.updateSession
    this.defaultMethod = this.makePeerRequest
    await this.send({ topic: this.id, type: 'sub', silent: true, payload: '' })
  }

  async requestSession (params) {
    let request = null
    try {
      if (!params.peerId) throw new Error('session missing peerId')
      if (!params.peerMeta) throw new Error('session missing peerMeta')
      request = {
        id: this.currentRequestId,
        method: 'wc_sessionRequest',
        params
      }
      this.peerId = params.peerId
      this.peerRequests.push(request)
      this.peerRequests = this.peerRequests
      this.methods.wc_sessionUpdate = this.updateSession
      this.dispatchEvent(new Event('sessionUpdate'))
    } catch (err) {
      this.destroySession(err)
      const d = this.onapproveSession
      delete this.onapproveSession
      d.reject(err)
    }
    return request.d
  }

  approveSession (request) {
    const params = request.params
    this.peerId = params.peerId
    this.peerMeta = params.peerMeta
    this.chainId = params.chainId || this.chainId
    this.peerRequests = this.peerRequests.filter(req => req.id !== request.id)
    delete this.methods.wc_sessionRequest
    this.defaultMethod = this.makePeerRequest
    const result = {
      approved: true,
      peerId: this.id,
      peerMeta: this.meta,
      chainId: this.chainId,
      accounts: this.accounts,
    }
    if (this.rpcUrl) {
      result.rpcUrl = this.rpcUrl
    }
    request.d.resolve(result)
    const d = this.onapproveSession
    delete this.onapproveSession
    if (d) d.resolve()
  }

  async updateSession (params) {
    if (params.approved === false) {
      this.destroySession(new Error('peer terminated the session'))
    } else {
      this.peerAccounts = params.accounts || this.peerAccounts
      this.chainId = params.chainId || this.chainId
      this.rpcUrl = params.rpcUrl || this.rpcUrl
      this.dispatchEvent(new Event('sessionUpdate'))
    }
  }

  destroySession (err) {
    if (this.defaultMethod) {
      this.notify('wc_sessionUpdate', {
        approved: false,
        accounts: []
      }).catch(err => {
        console.error('failed to notify peer about session destruction:', err.message)
      }).finally(() => {
        this.closeBridge()
      })
    }
    delete this.defaultMethod
    for (let name in this.methods) {
      delete this.methods[name]
    }
    const d = this.onapproveSession
    delete this.onapproveSession
    if (d) d.reject(err)
    const evt = new Event('sessionDestroy')
    if (err) evt.error = err
    this.dispatchEvent(evt)
  }

  async makeRequest (name, params) {
    const d = this.call(name, params)
    for (var id in this.callbacks) {
      if (this.callbacks[id] === d) {
        break
      }
    }
    const request = {
      id,
      method: name,
      params
    }
    this.requests.push(request)
    this.requests = this.requests
    this.dispatchEvent(new Event('sessionUpdate'))
    return d
  }

  async makePeerRequest (name, params) {
    const request = {
      id: this.currentRequestId,
      method: name,
      params
    }
    this.peerRequests.push(request)
    this.peerRequests = this.peerRequests
    this.dispatchEvent(new Event('sessionUpdate'))
    return request.d
  }

  async openBridge () {
    let err = null
    const d = new Deferred()
    this.socket = new WebSocket(this.bridge + '?env=browser&protocol=wc&version=' + this.version)
    const timeout = setTimeout(() => {
      err = new Error('bridge connect timed out')
      this.socket.close()
    }, 5 * 1000)
    const onopen = () => {
      clearTimeout(timeout)
      this.socket.removeEventListener('close', onclose)
      this.socket.addEventListener('close', this.onbridgeClose)
      this.socket.addEventListener('message', this.receive)
      d.resolve()
    }
    const onclose = evt => {
      clearTimeout(timeout)
      this.socket.removeEventListener('open', onopen)
      d.reject(err || new Error('bridge closed unexpectedly'))
    }
    this.socket.addEventListener('open', onopen)
    this.socket.addEventListener('close', onclose)
    return d
  }

  closeBridge () {
    if (!this.socket) return
    this.socket.close()
  }

  onbridgeClose () {
    this.socket = null
    this.dispatchEvent(new Event('bridgeClose'))
    this.close()
  }

  async genKeys () {
    this.cipherKey = await this.crypto.subtle.importKey('raw', this.key, {
      name: 'AES-CBC',
      length: 256
    }, true, [ 'encrypt', 'decrypt' ])
    this.hmacKey = await this.crypto.subtle.importKey('raw', this.key, {
      name: 'HMAC',
      hash: 'SHA-256'
    }, true, [ 'sign', 'verify' ])
  }

  async send (message) {
    if (message.topic && message.type) {
      // control plane
      this.socket.send(JSON.stringify(message))
      return
    }
    // data plane
    if (!this.cipherKey || !this.hmacKey) {
      await this.genKeys()
    }
    message = Uint8Array.from(utf8.encode(JSON.stringify(message)))
    const iv = this.crypto.getRandomValues(new Uint8Array(16))
    const cipherText = new Uint8Array(await this.crypto.subtle.encrypt({ name: 'AES-CBC', iv }, this.cipherKey, message))
    const data = new Uint8Array(iv.length + cipherText.length)
    data.set(cipherText)
    data.set(iv, cipherText.length)
    const hmac = new Uint8Array(await this.crypto.subtle.sign('HMAC', this.hmacKey, data))
    const payload = JSON.stringify({
      iv: hex.encode(iv),
      data: hex.encode(cipherText),
      hmac: hex.encode(hmac)
    })
    const topic = this.peerId ? this.peerId : this.handshakeId
    this.socket.send(JSON.stringify({ topic, type: 'pub', silent: true, payload }))
  }

  async receive (evt) {
    if (!this.cipherKey || !this.hmacKey) {
      await this.genKeys()
    }
    const wrapper = JSON.parse(evt.data)
    if (wrapper.topic) {
      this.send({ topic: wrapper.topic, type: 'ack', payload: '', silent: true }).catch(err => {})
    }
    const payload = JSON.parse(wrapper.payload)
    const iv = hex.decode(payload.iv)
    const cipherText = hex.decode(payload.data)
    const data = new Uint8Array(iv.length + cipherText.length)
    data.set(cipherText)
    data.set(iv, cipherText.length)
    const hmac = hex.decode(payload.hmac)
    if (!await this.crypto.subtle.verify('HMAC', this.hmacKey, hmac, data)) throw new Error('hmac verification failed')
    const message = await this.crypto.subtle.decrypt({ name: 'AES-CBC', iv }, this.cipherKey, cipherText)
    const request = JSON.parse(utf8.decode(new Uint8Array(message)))
    if (request.method === 'wc_sessionUpdate') {
      // some wallets do not implement rpc correctly
      // and send notifications that include id
      delete request.id
    }
    await super.receive(request)
  }

  async handleRequest (name, message) {
    // override of RpcEngine's handleRequest
    // to capture the current request context
    if (!message || message.id === undefined) return
    this.currentRequestId = message.id
    return super.handleRequest(name, message)
  }
}

export default WalletConnect
