/**
 * peer.js
 * Thin wrapper around PeerJS that gives the app:
 *   - hostRoom(code)  / joinRoom(code)   -> peer-to-peer data channel, no backend
 *   - send(type, payload)                -> push a sync/chat message to the other side
 *   - onMessage(type, payload)           -> receive one
 *   - startMic(stream) / stopMic()       -> one-way audio call for the optional mic
 *
 * Uses PeerJS's free public signaling broker (0.peerjs.com) purely to exchange
 * connection info. Once connected, video/audio/data flow directly between the
 * two browsers (WebRTC) - nothing is proxied or stored on any server.
 */

class RoomPeer {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.outgoingCall = null;
    this.isHost = false;
    this.roomCode = null;

    this.onMessage = null;        // (type, payload) => void
    this.onPeerConnected = null;  // () => void
    this.onPeerDisconnected = null; // () => void
    this.onRemoteStream = null;   // (MediaStream) => void
    this.onError = null;          // (err) => void
  }

  hostRoom(code) {
    this.isHost = true;
    this.roomCode = code;
    this.peer = new Peer(code, { debug: 1 });

    return new Promise((resolve, reject) => {
      let settled = false;
      this.peer.on('open', (id) => { settled = true; resolve(id); });
      this.peer.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
        else if (this.onError) this.onError(err);
      });
      this.peer.on('connection', (conn) => this._bindConnection(conn));
      this.peer.on('call', (call) => this._bindIncomingCall(call));
    });
  }

  joinRoom(code) {
    this.isHost = false;
    this.roomCode = code;
    this.peer = new Peer({ debug: 1 });

    return new Promise((resolve, reject) => {
      let settled = false;
      this.peer.on('open', () => {
        const conn = this.peer.connect(code, { reliable: true });
        this._bindConnection(conn);
        conn.on('open', () => { settled = true; resolve(conn.peer); });
        conn.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
      });
      this.peer.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
        else if (this.onError) this.onError(err);
      });
      this.peer.on('call', (call) => this._bindIncomingCall(call));

      // if the code doesn't exist, PeerJS eventually errors with 'peer-unavailable'
      setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('timeout')); }
      }, 15000);
    });
  }

  _bindConnection(conn) {
    this.conn = conn;
    conn.on('data', (data) => {
      if (this.onMessage && data && data.type) this.onMessage(data.type, data.payload);
    });
    conn.on('open', () => { if (this.onPeerConnected) this.onPeerConnected(); });
    conn.on('close', () => { if (this.onPeerDisconnected) this.onPeerDisconnected(); });
    conn.on('error', (err) => { if (this.onError) this.onError(err); });
  }

  send(type, payload) {
    if (this.conn && this.conn.open) {
      this.conn.send({ type, payload });
    }
  }

  isConnected() {
    return !!(this.conn && this.conn.open);
  }

  /** Start sending our mic audio to the other side (one-directional call). */
  startMic(stream) {
    if (!this.conn) return;
    this.outgoingCall = this.peer.call(this.conn.peer, stream);
  }

  stopMic() {
    if (this.outgoingCall) {
      this.outgoingCall.close();
      this.outgoingCall = null;
    }
  }

  /** Someone is sending us their mic audio - just receive, don't require ours. */
  _bindIncomingCall(call) {
    call.answer();
    call.on('stream', (remoteStream) => {
      if (this.onRemoteStream) this.onRemoteStream(remoteStream);
    });
  }

  destroy() {
    if (this.outgoingCall) this.outgoingCall.close();
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
  }
}
