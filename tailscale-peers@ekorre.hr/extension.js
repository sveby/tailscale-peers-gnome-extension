// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 10;
const PING_TIMEOUT_SECONDS = 2;
// Latency is only measured while the menu is open; reuse a result for this long.
const PING_CACHE_SECONDS = 30;
const ADMIN_URL = 'https://login.tailscale.com/admin/machines';

const ICONS = {
    connected: 'network-vpn-symbolic',
    stopped: 'network-vpn-disabled-symbolic',
    pending: 'network-vpn-acquiring-symbolic',
    error: 'network-error-symbolic',
};

function runTailscale(args, cancellable) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(['tailscale', ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({ok: p.get_successful(), stdout, stderr});
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function tailscaleStatus(cancellable) {
    const {stdout, stderr} = await runTailscale(['status', '--json'], cancellable);
    // `tailscale status --json` still prints JSON when logged out or stopped,
    // so only treat empty output as a failure.
    if (!stdout.trim())
        throw new Error(stderr.trim() || 'tailscale status failed');
    return JSON.parse(stdout);
}

// One disco ping at the Tailscale layer; doesn't need operator rights.
// Output looks like "pong from host (100.x.y.z) via 1.2.3.4:41641 in 23ms"
// or "... via DERP(fra) in 41ms".
async function tailscalePing(ip, cancellable) {
    const {stdout} = await runTailscale(
        ['ping', '-c', '1', '--timeout', `${PING_TIMEOUT_SECONDS}s`, ip], cancellable);
    const ms = stdout.match(/ in ([\d.]+)\s*ms/);
    return ms ? Math.round(parseFloat(ms[1])) : null;
}

function formatBytes(n) {
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < units.length - 1) {
        n /= 1000;
        i++;
    }
    return `${i === 0 || n >= 10 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function dnsName(node) {
    return (node.DNSName ?? '').replace(/\.$/, '') || node.HostName;
}

function relativeTime(iso) {
    const then = Date.parse(iso);
    if (!then || then < 0)
        return null;
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60)
        return 'just now';
    if (s < 3600)
        return `${Math.floor(s / 60)} min ago`;
    if (s < 86400)
        return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
}

// How we reach this peer: 'online' (direct), 'idle' (online, no active connection) or 'offline'.
function describePeer(peer) {
    const parts = [];
    let state;
    if (!peer.Online) {
        state = 'offline';
        const seen = relativeTime(peer.LastSeen);
        parts.push(seen ? `last seen ${seen}` : 'offline');
    } else if (peer.CurAddr) {
        state = 'online';
        parts.push('direct');
    } else if (peer.PeerRelay) {
        state = 'online';
        parts.push('peer relay');
    } else if (peer.Active) {
        state = 'online';
        parts.push(peer.Relay ? `relay · ${peer.Relay}` : 'relay');
    } else {
        state = 'idle';
        parts.push('idle');
    }
    if (peer.ExitNode)
        parts.push('exit node');
    else if (peer.ExitNodeOption)
        parts.push('can be exit node');
    if (peer.OS)
        parts.push(peer.OS);
    return {state, detail: parts.join(' · ')};
}

function ipv4(node) {
    const ips = node.TailscaleIPs ?? [];
    return ips.find(ip => !ip.includes(':')) ?? ips[0] ?? '';
}

function shortDnsName(node) {
    return (node.DNSName ?? '').split('.')[0] || node.HostName;
}

function copyToClipboard(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    const icon = Gio.ThemedIcon.new('edit-copy-symbolic');
    const label = `Copied ${text}`;
    const osd = Main.osdWindowManager;
    if (osd.showAll)
        osd.showAll(icon, label); // GNOME 49+
    else
        osd.show(-1, icon, label); // GNOME 45–48
}

const PeerItem = GObject.registerClass(
class PeerItem extends PopupMenu.PopupBaseMenuItem {
    constructor(node, {self = false} = {}) {
        super();
        const {state, detail} = self
            ? {state: 'online', detail: 'this device'}
            : describePeer(node);
        this._ip = ipv4(node);
        this._dnsName = dnsName(node);
        this._traffic = node.RxBytes || node.TxBytes
            ? `↓ ${formatBytes(node.RxBytes ?? 0)}  ↑ ${formatBytes(node.TxBytes ?? 0)}`
            : '';
        this._latency = '';

        this.add_child(new St.Widget({
            style_class: `tsp-dot ${state}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        text.add_child(new St.Label({text: node.HostName || shortDnsName(node), style_class: 'tsp-name'}));
        text.add_child(new St.Label({text: detail, style_class: 'tsp-detail'}));
        this.add_child(text);

        const right = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        right.add_child(new St.Label({
            text: this._ip,
            style_class: 'tsp-ip',
            x_align: Clutter.ActorAlign.END,
        }));
        this._meta = new St.Label({style_class: 'tsp-meta', x_align: Clutter.ActorAlign.END});
        right.add_child(this._meta);
        this.add_child(right);

        this.accessible_name = `${node.HostName}, ${detail}, ${this._ip}`;
        this._updateMeta();
    }

    get ip() {
        return this._ip;
    }

    setLatency(ms) {
        this._latency = ms === null ? 'no reply' : `${ms} ms`;
        this._updateMeta();
    }

    _updateMeta() {
        const text = [this._latency, this._traffic].filter(Boolean).join('  ·  ');
        this._meta.text = text;
        this._meta.visible = text !== '';
    }

    // The item's click handling activates on any mouse button, so right-click lands here too.
    activate(event) {
        const secondary = event?.type() === Clutter.EventType.BUTTON_RELEASE &&
            event.get_button() === Clutter.BUTTON_SECONDARY;
        const text = secondary ? this._dnsName : this._ip;
        if (text)
            copyToClipboard(text);
        super.activate(event);
    }
});

const TailscaleIndicator = GObject.registerClass(
class TailscaleIndicator extends PanelMenu.Button {
    constructor() {
        super(0.5, 'Tailscale Peers');

        this._icon = new St.Icon({icon_name: ICONS.pending, style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._cancellable = new Gio.Cancellable();
        this._refreshing = false;
        this._peerItems = new Map(); // peer ID → PeerItem, online peers only
        this._latency = new Map(); // peer ID → {ms, at}
        this._pinging = new Set(); // peer IDs with a ping in flight

        this._content = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._content);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const hint = new PopupMenu.PopupMenuItem('Click: copy IP  ·  Right-click: copy name', {reactive: false});
        hint.label.add_style_class_name('tsp-hint');
        this.menu.addMenuItem(hint);
        this.menu.addAction('Open admin console', () => {
            Gio.AppInfo.launch_default_for_uri(ADMIN_URL, null);
        });

        this.menu.connect('open-state-changed', async (_menu, open) => {
            if (!open)
                return;
            await this._refresh();
            this._pingOnlinePeers();
        });

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            // Don't rebuild the list under the pointer while the menu is open.
            if (!this.menu.isOpen)
                this._refresh();
            return GLib.SOURCE_CONTINUE;
        });

        this._refresh();
    }

    async _refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        try {
            if (!GLib.find_program_in_path('tailscale'))
                throw new Error('tailscale CLI not found');
            const status = await tailscaleStatus(this._cancellable);
            this._render(status);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._renderError(e.message);
        } finally {
            this._refreshing = false;
        }
    }

    _pingOnlinePeers() {
        const now = GLib.get_monotonic_time() / 1e6;
        for (const [id, item] of this._peerItems) {
            const cached = this._latency.get(id);
            if (!item.ip || this._pinging.has(id) || (cached && now - cached.at < PING_CACHE_SECONDS))
                continue;
            this._pinging.add(id);
            tailscalePing(item.ip, this._cancellable).then(ms => {
                this._latency.set(id, {ms, at: GLib.get_monotonic_time() / 1e6});
                // The list may have been rebuilt meanwhile; update whichever item is current.
                this._peerItems.get(id)?.setLatency(ms);
            }).catch(e => {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`Tailscale Peers: ping ${item.ip}: ${e.message}`);
            }).finally(() => this._pinging.delete(id));
        }
    }

    _setHeader(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.add_style_class_name('tsp-header');
        this._content.addMenuItem(item);
    }

    _renderError(message) {
        this._icon.icon_name = ICONS.error;
        this._content.removeAll();
        this._peerItems.clear();
        this._setHeader(`Tailscale unavailable: ${message}`);
    }

    _render(status) {
        const backend = status.BackendState;
        this._icon.icon_name = backend === 'Running' ? ICONS.connected
            : backend === 'Stopped' ? ICONS.stopped
            : backend === 'NoState' || backend === 'Starting' ? ICONS.pending
            : ICONS.error;

        this._content.removeAll();
        this._peerItems.clear();

        const tailnet = status.CurrentTailnet?.Name;
        if (backend !== 'Running') {
            const reasons = {
                Stopped: 'Tailscale is stopped',
                NeedsLogin: 'Tailscale needs login',
                NeedsMachineAuth: 'This device is waiting for admin approval',
                Starting: 'Tailscale is starting…',
                NoState: 'Tailscale is starting…',
            };
            this._setHeader(reasons[backend] ?? `Tailscale: ${backend}`);
            return;
        }

        const peers = Object.values(status.Peer ?? {});
        const online = peers.filter(p => p.Online).length;
        this._setHeader(`${tailnet ? `${tailnet} · ` : ''}${online} of ${peers.length} devices online`);

        for (const warning of status.Health ?? []) {
            const item = new PopupMenu.PopupMenuItem(warning, {reactive: false});
            item.label.add_style_class_name('tsp-warning');
            item.label.clutter_text.line_wrap = true;
            this._content.addMenuItem(item);
        }

        if (status.Self)
            this._content.addMenuItem(new PeerItem(status.Self, {self: true}));

        const byName = (a, b) => (a.HostName ?? '').localeCompare(b.HostName ?? '');
        const onlinePeers = peers.filter(p => p.Online).sort(byName);
        const offlinePeers = peers.filter(p => !p.Online)
            .sort((a, b) => Date.parse(b.LastSeen) - Date.parse(a.LastSeen));

        if (onlinePeers.length)
            this._content.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const peer of onlinePeers) {
            const item = new PeerItem(peer);
            const cached = this._latency.get(peer.ID);
            if (cached)
                item.setLatency(cached.ms);
            this._peerItems.set(peer.ID, item);
            this._content.addMenuItem(item);
        }

        if (offlinePeers.length) {
            const sub = new PopupMenu.PopupSubMenuMenuItem(`Offline (${offlinePeers.length})`);
            for (const peer of offlinePeers)
                sub.menu.addMenuItem(new PeerItem(peer));
            this._content.addMenuItem(sub);
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }
});

export default class TailscalePeersExtension extends Extension {
    enable() {
        this._indicator = new TailscaleIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
