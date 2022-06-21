// import WebSocket from 'ws' // TODO this doesn't work for some reason
import WebSocketServer from './node_modules/ws/lib/websocket-server.js'
const WebSocket = { Server: WebSocketServer }
import dgram from 'dgram'

let wsClients = []
const wsServer = new WebSocket.Server({
  host: process.env.WS_HOST || '::',
  port: process.env.WS_PORT || '3000'
})
wsServer.on('listening', () => {
  const { host, port } = wsServer.options
  console.log('listening', host, port)
})

wsServer.on('connection', (client, req) => {
  client.sessions = []
  client.id = req.socket.remotePort
  client.on('error', onclose)
  client.on('close', onclose)
  client.on('message', onmessage)
  wsClients.push(client)
  console.log('connect', client.id)
  function onmessage (rawMessage) {
    rawMessage = rawMessage.toString()
    let message = null
    try {
      message = JSON.parse(rawMessage)
    } catch (err) {
      client.destroy()
      return
    }
    const type = message.type
    if (!type) return
    const topic = message.topic
    if (!topic) return
    let session = sessions[topic]
    if (!session) {
      session = sessions[topic] = {}
    }
    session.touched = new Date()
    if (type === 'sub') {
      session.subs = session.subs || []
      if (!session.subs.find(sub => sub === client)) {
        session.subs.push(client)
        client.sessions.push(session)
      }
      if (session.cached) {
        client.send(session.cached)
        delete session.cached
      }
    } else if (type === 'pub') {
      if (!session.subs) {
        session.cached = rawMessage
        return
      }
      session.subs.forEach(sub => sub.send(rawMessage))
    }
  }
  function onclose (err) {
    client.sessions.forEach(session => {
      if (session.subs) {
        session.subs = session.subs.filter(sub => sub !== this)
        if (session.subs.length === 0) delete session.subs
      }
    })
    delete client.sessions
    client.removeListener('error', onclose)
    client.removeListener('close', onclose)
    client.removeListener('message', onmessage)
    wsClients = wsClients.filter(c => c !== client)
    if (err) {
      console.error('disconnect with error', err, client.id)
    } else {
      console.log('disconnect', client.id)
    }
  }
})

const sessions = {}
const cullInterval = 10 * 1000
setTimeout(cull, cullInterval)
function cull () {
  const now = new Date()
  for (let key in sessions) {
    const session = sessions[key]
    const maxAge = 1 * 60 * 1000
    if (now - session.touched > maxAge) {
      if (!session.subs) {
        console.log('clearing session', key)
        delete sessions[key]
      }
    }
  }
  setTimeout(cull, cullInterval)
}
