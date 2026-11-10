import { parseGameMessage, type GameMessage, type RtcPayload } from '../../shared/protocols/messages.js';
import type { NetSession } from './session.js';

export type LinkKind = 'rtc' | 'relay';

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  kind: LinkKind;
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** How long a WebRTC link may take to open before traffic is routed through the server. */
export const RTC_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Game-traffic transport. Each client holds one WebRTC data channel to the host (a star topology);
 * the host holds one per client. When a channel cannot open, messages go through the signaling
 * server's relay instead, so play keeps working behind strict NATs.
 */
export class PeerMesh {
  private readonly peers = new Map<string, Peer>();

  constructor(
    private readonly session: NetSession,
    readonly localId: string,
    readonly isHost: boolean,
    readonly hostId: string,
    private readonly onGame: (from: string, msg: GameMessage) => void,
    private readonly iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }],
    private readonly onLink?: (id: string, kind: LinkKind) => void,
  ) {}

  /** Client: open a data channel to the host. */
  connectToHost(): void {
    if (this.isHost) return;
    const peer = this.createPeer(this.hostId);
    const channel = peer.pc.createDataChannel('game');
    this.attachChannel(peer, channel);
    void (async () => {
      try {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        this.session.rtc(this.hostId, { kind: 'offer', sdp: offer.sdp ?? '' });
      } catch {
        this.fallback(peer);
      }
    })();
  }

  /** Handles SDP and ICE from the signaling server. The host answers incoming offers. */
  async handleRtc(from: string, payload: RtcPayload): Promise<void> {
    let peer = this.peers.get(from);
    if (payload.kind === 'offer') {
      if (!this.isHost) return;
      if (peer) this.destroy(from);
      peer = this.createPeer(from);
      const p = peer;
      p.pc.ondatachannel = (ev) => this.attachChannel(p, ev.channel);
      try {
        await p.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        p.remoteSet = true;
        await this.drainIce(p);
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        this.session.rtc(from, { kind: 'answer', sdp: answer.sdp ?? '' });
      } catch {
        this.fallback(p);
      }
      return;
    }
    if (!peer) return;
    try {
      if (payload.kind === 'answer') {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        peer.remoteSet = true;
        await this.drainIce(peer);
      } else if (payload.kind === 'ice') {
        const candidate = payload.candidate as RTCIceCandidateInit | null;
        if (!candidate) return;
        if (!peer.remoteSet) peer.pendingIce.push(candidate);
        else await peer.pc.addIceCandidate(candidate);
      }
    } catch {
      this.fallback(peer);
    }
  }

  /** Sends to one peer over the data channel if open, otherwise over the relay. */
  send(to: string, msg: GameMessage): void {
    const peer = this.peers.get(to);
    if (peer?.channel && peer.channel.readyState === 'open') {
      peer.channel.send(JSON.stringify(msg));
      return;
    }
    this.session.relay(to, msg);
  }

  /** Sends to every connected peer (host) or to the host (client). */
  broadcast(msg: GameMessage, except?: string): void {
    if (!this.isHost) {
      this.send(this.hostId, msg);
      return;
    }
    for (const id of this.peers.keys()) if (id !== except) this.send(id, msg);
  }

  /** Removes peers that have left the session. */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of [...this.peers.keys()]) if (!keep.has(id)) this.destroy(id);
  }

  kindOf(id: string): LinkKind {
    return this.peers.get(id)?.kind ?? 'relay';
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.destroy(id);
  }

  // ---------------------------------------------------------------- internals

  private createPeer(id: string): Peer {
    this.destroy(id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { id, pc, channel: null, kind: 'relay', pendingIce: [], remoteSet: false, timer: null };
    this.peers.set(id, peer);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.session.rtc(id, { kind: 'ice', candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.fallback(peer);
    };
    peer.timer = setTimeout(() => {
      if (peer.kind !== 'rtc') this.fallback(peer);
    }, RTC_CONNECT_TIMEOUT_MS);
    return peer;
  }

  private attachChannel(peer: Peer, channel: RTCDataChannel): void {
    peer.channel = channel;
    channel.onopen = () => this.setKind(peer, 'rtc');
    channel.onclose = () => this.setKind(peer, 'relay');
    channel.onmessage = (ev) => {
      try {
        const msg = parseGameMessage(JSON.parse(String(ev.data)));
        this.onGame(peer.id, msg);
      } catch {
        // Malformed payloads from a peer are ignored.
      }
    };
    if (channel.readyState === 'open') this.setKind(peer, 'rtc');
  }

  private setKind(peer: Peer, kind: LinkKind): void {
    if (peer.kind === kind) return;
    peer.kind = kind;
    if (kind === 'rtc' && peer.timer) {
      clearTimeout(peer.timer);
      peer.timer = null;
    }
    this.onLink?.(peer.id, kind);
  }

  private async drainIce(peer: Peer): Promise<void> {
    const queued = peer.pendingIce.splice(0);
    for (const c of queued) await peer.pc.addIceCandidate(c);
  }

  /** Gives up on the direct link: keep the peer entry but route all traffic through the relay. */
  private fallback(peer: Peer): void {
    if (peer.kind === 'relay' && !peer.channel) return;
    peer.channel?.close();
    peer.channel = null;
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = null;
    this.setKind(peer, 'relay');
  }

  private destroy(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (peer.timer) clearTimeout(peer.timer);
    peer.channel?.close();
    peer.pc.close();
    this.peers.delete(id);
  }
}
