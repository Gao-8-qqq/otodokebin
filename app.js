"use strict";
(function () {
const {
  useState,
  useEffect,
  useCallback
} = React;
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBDQ0SQGRdi8tViM3bBaYLew3GvcLyTilc',
  authDomain: 'otodokebin-4cea6.firebaseapp.com',
  projectId: 'otodokebin-4cea6',
  storageBucket: 'otodokebin-4cea6.firebasestorage.app',
  messagingSenderId: '1054532765944',
  appId: '1:1054532765944:web:598ea9708415beb1fd130d'
};
firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
auth.languageCode = 'ja';
const db = firebase.firestore();
const FV = firebase.firestore.FieldValue;
const googleProvider = new firebase.auth.GoogleAuthProvider();
const TRACK_INFO_URL = 'https://xqnhxjepxzglmsnmdrvm.supabase.co/functions/v1/track-info';
const TRACK_INFO_KEY = 'sb_publishable_FRoeyOoJFYtM7QsQ8cjuqw_2yqFF7bj';
const GUEST_CAN_CREATE = true;
const SCENES = [{
  id: 1,
  name: '悲しい時'
}, {
  id: 2,
  name: '嬉しい時'
}, {
  id: 3,
  name: '通勤通学中'
}, {
  id: 4,
  name: '作業中'
}, {
  id: 5,
  name: '子育て中'
}, {
  id: 6,
  name: '家事中'
}, {
  id: 7,
  name: '眠れない夜'
}, {
  id: 8,
  name: '朝起きた時'
}, {
  id: 9,
  name: '失恋した時'
}, {
  id: 10,
  name: '恋してる時'
}, {
  id: 11,
  name: 'ドライブ'
}];
const sceneName = id => (SCENES.find(s => s.id === id) || {}).name || '';
const toUser = u => u ? {
  id: u.uid,
  is_anonymous: u.isAnonymous,
  email: u.email || ''
} : null;
const authChanged = () => window.dispatchEvent(new Event('authchange'));
async function ensureGuest() {
  if (auth.currentUser) return auth.currentUser;
  try {
    const cred = await auth.signInAnonymously();
    return cred.user;
  } catch (e) {
    throw new Error('ゲストで始められなかった…（' + (e.code || e.message) + '）');
  }
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function randomTag() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
function jstDay() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
}
async function readDaily(uid) {
  const ref = db.doc('users/' + uid + '/daily/' + jstDay());
  const snap = await ref.get();
  const d = snap.exists ? snap.data() : {};
  return {
    ref,
    recv: d.recv || 0,
    made: d.made || 0
  };
}
async function myTag(uid) {
  const ref = db.doc('users/' + uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data().tag;
  const tag = randomTag();
  await ref.set({
    tag
  });
  return tag;
}
async function deleteAll(query) {
  const snap = await query.get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const b = db.batch();
    snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref));
    await b.commit();
  }
}
const api = {
  async createSetlist(sceneId, comment, tracks) {
    const u = await ensureGuest();
    if (u.isAnonymous && !GUEST_CAN_CREATE) throw new Error('login_required');
    if (tracks.length < 3 || tracks.length > 10) throw new Error('tracks_must_be_3_to_10');
    const c = (comment || '').trim() || null;
    if (c && (c.length > 100 || /(https?:\/\/|www\.|\.com|@[a-z0-9_]{2,})/i.test(c))) throw new Error('setlists_comment_check');
    const tag = await myTag(u.uid);
    const day = await readDaily(u.uid);
    if (day.made >= (u.isAnonymous ? 3 : 20)) throw new Error('create_limit_reached');
    const ref = db.collection('setlists').doc();
    const b = db.batch();
    b.set(ref, {
      scene: sceneId,
      comment: c,
      tracks: tracks.map(t => ({
        url: t.url,
        service: t.service,
        title: t.title ? t.title.slice(0, 200) : null,
        artist: t.artist ? t.artist.slice(0, 200) : null,
        thumbnail: t.thumbnail && /^https:\/\//.test(t.thumbnail) ? t.thumbnail.slice(0, 500) : null
      })),
      createdAt: FV.serverTimestamp(),
      bucket: Math.floor(Math.random() * 10),
      author: tag,
      delivered: 0,
      stamps: {},
      reports: 0,
      hidden: false
    });
    b.set(db.doc('owners/' + ref.id), {
      uid: u.uid,
      createdAt: FV.serverTimestamp()
    });
    b.set(day.ref, {
      recv: day.recv,
      made: day.made + 1
    });
    await b.commit();
    return ref.id;
  },
  async receive(sceneId) {
    const u = await ensureGuest();
    const day = await readDaily(u.uid);
    if (day.recv >= (u.isAnonymous ? 3 : 10)) throw new Error('daily_limit_reached');
    const [recvSnap, ownSnap, blockSnap] = await Promise.all([db.collection('users/' + u.uid + '/received').get(), db.collection('owners').where('uid', '==', u.uid).get(), db.collection('users/' + u.uid + '/blocks').get()]);
    const skip = new Set([...recvSnap.docs.map(d => d.id), ...ownSnap.docs.map(d => d.id)]);
    const blocked = new Set(blockSnap.docs.map(d => d.id));
    let fails = 0;
    for (const bucket of shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])) {
      const q = await db.collection('setlists').where('scene', '==', sceneId).where('hidden', '==', false).where('bucket', '==', bucket).limit(50).get();
      const cands = shuffle(q.docs.filter(d => !skip.has(d.id) && !blocked.has(d.data().author)));
      for (const d of cands) {
        try {
          const b = db.batch();
          b.set(d.ref.collection('deliveries').doc(u.uid), {
            at: FV.serverTimestamp()
          });
          b.update(d.ref, {
            delivered: FV.increment(1)
          });
          b.set(db.doc('users/' + u.uid + '/received/' + d.id), {
            at: FV.serverTimestamp()
          });
          b.set(day.ref, {
            recv: day.recv + 1,
            made: day.made
          });
          await b.commit();
          const s = d.data();
          return {
            setlist_id: d.id,
            scene: sceneName(s.scene),
            tracks: s.tracks || [],
            comment: s.comment,
            author: s.author
          };
        } catch (e) {
          if (e.code !== 'permission-denied' || ++fails >= 5) throw e;
          skip.add(d.id);
        }
      }
    }
    return null;
  },
  async stamp(setlistId, stamp) {
    const u = auth.currentUser;
    const ref = db.doc('setlists/' + setlistId);
    const b = db.batch();
    b.set(ref.collection('reactions').doc(u.uid), {
      stamp,
      at: FV.serverTimestamp()
    });
    b.update(ref, {
      ['stamps.' + stamp]: FV.increment(1)
    });
    await b.commit();
  },
  async report(setlistId) {
    const u = auth.currentUser;
    const ref = db.doc('setlists/' + setlistId);
    const cur = (await ref.get()).data();
    const b = db.batch();
    b.set(db.doc('reports/' + setlistId + '_' + u.uid), {
      setlist: setlistId,
      at: FV.serverTimestamp()
    });
    b.update(ref, {
      reports: FV.increment(1),
      hidden: !!cur.hidden || cur.reports + 1 >= 3
    });
    await b.commit();
  },
  async block(authorTag) {
    const u = auth.currentUser;
    await db.doc('users/' + u.uid + '/blocks/' + authorTag).set({
      at: FV.serverTimestamp()
    });
  },
  async mySetlists() {
    const u = auth.currentUser;
    if (!u) return [];
    const own = await db.collection('owners').where('uid', '==', u.uid).get();
    const rows = await Promise.all(own.docs.map(async o => {
      const s = await db.doc('setlists/' + o.id).get();
      if (!s.exists) return null;
      const d = s.data();
      return {
        setlist_id: o.id,
        scene: sceneName(d.scene),
        comment: d.comment,
        tracks: d.tracks || [],
        deliveries: d.delivered || 0,
        stamps: d.stamps || {},
        hidden: !!d.hidden,
        created: o.data().createdAt ? o.data().createdAt.toMillis() : 0
      };
    }));
    return rows.filter(Boolean).sort((a, b) => b.created - a.created);
  },
  async deleteSetlist(setlistId) {
    const ref = db.doc('setlists/' + setlistId);
    await deleteAll(ref.collection('deliveries'));
    await deleteAll(ref.collection('reactions'));
    const b = db.batch();
    b.delete(ref);
    b.delete(db.doc('owners/' + setlistId));
    await b.commit();
  },
  async deleteAccount(password) {
    const u = auth.currentUser;
    const providers = u.providerData.map(p => p.providerId);
    if (providers.includes('google.com')) await u.reauthenticateWithPopup(googleProvider);else if (providers.includes('password')) {
      await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, password || ''));
    }
    const own = await db.collection('owners').where('uid', '==', u.uid).get();
    for (const o of own.docs) await api.deleteSetlist(o.id);
    await deleteAll(db.collection('users/' + u.uid + '/received'));
    await deleteAll(db.collection('users/' + u.uid + '/blocks'));
    const daily = await db.collection('users/' + u.uid + '/daily').get();
    for (const d of daily.docs) {
      if (d.id !== jstDay()) await d.ref.delete();
    }
    await db.doc('users/' + u.uid).delete();
    await u.delete();
  },
  async loginGoogle() {
    const cur = auth.currentUser;
    if (cur && cur.isAnonymous) {
      try {
        await cur.linkWithPopup(googleProvider);
        await cur.getIdToken(true);
        authChanged();
        return;
      } catch (e) {
        if (e.code === 'auth/credential-already-in-use' && e.credential) {
          await auth.signInWithCredential(e.credential);
          return;
        }
        throw e;
      }
    }
    await auth.signInWithPopup(googleProvider);
  },
  async signUpEmail(email, password) {
    const cur = auth.currentUser;
    if (cur && cur.isAnonymous) {
      await cur.linkWithCredential(firebase.auth.EmailAuthProvider.credential(email, password));
      await cur.getIdToken(true);
      authChanged();
      return;
    }
    await auth.createUserWithEmailAndPassword(email, password);
  },
  async signInEmail(email, password) {
    await auth.signInWithEmailAndPassword(email, password);
  },
  async resetPassword(email) {
    await auth.sendPasswordResetEmail(email);
  }
};
const STAMPS = [{
  id: 'sasatta',
  label: '刺さった'
}, {
  id: 'naita',
  label: '泣いた'
}, {
  id: 'genki',
  label: '元気出た'
}, {
  id: 'wakaru',
  label: 'わかる'
}, {
  id: 'suki',
  label: '好き'
}, {
  id: 'mata',
  label: 'また聴く'
}];
const SERVICES = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  apple_music: 'Apple Music',
  amazon_music: 'Amazon Music'
};
const TUBES = ['var(--violet)', 'var(--cyan)', 'var(--pink)', 'var(--amber)'];
const REDIRECT_TO = location.origin + location.pathname;
function detectService(raw) {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (h === 'youtu.be' || h === 'youtube.com' || h === 'music.youtube.com') return 'youtube';
    if (h === 'open.spotify.com' || h === 'spotify.link') return 'spotify';
    if (h === 'music.apple.com') return 'apple_music';
    if (h === 'music.amazon.co.jp' || h === 'music.amazon.com') return 'amazon_music';
    if ((h === 'amazon.co.jp' || h === 'amazon.com') && u.pathname.startsWith('/music')) return 'amazon_music';
  } catch (e) {}
  return null;
}
async function fetchMeta(url, service) {
  try {
    const r = await fetch(TRACK_INFO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: TRACK_INFO_KEY
      },
      body: JSON.stringify({
        url
      })
    });
    const data = r.ok ? await r.json() : null;
    if (data && (data.title || data.artist)) {
      return {
        title: data.title || '',
        artist: data.artist || '',
        thumbnail: data.thumbnail || ''
      };
    }
  } catch (e) {}
  let endpoint = null;
  if (service === 'spotify') endpoint = 'https://open.spotify.com/oembed?url=' + encodeURIComponent(url);
  if (service === 'youtube') endpoint = 'https://noembed.com/embed?url=' + encodeURIComponent(url);
  if (!endpoint) return {};
  try {
    const r = await fetch(endpoint);
    if (!r.ok) return {};
    const j = await r.json();
    if (j.error) return {};
    const artist = service === 'youtube' ? (j.author_name || '').replace(/ - Topic$/, '') : '';
    return {
      title: j.title || '',
      artist,
      thumbnail: j.thumbnail_url || ''
    };
  } catch (e) {
    return {};
  }
}
const AUTH_ERRORS = {
  'auth/email-already-in-use': 'このメールはもう登録されてるよ。「ログイン」から入ってね。',
  'auth/invalid-credential': 'メールアドレスかパスワードが違うみたい。',
  'auth/wrong-password': 'パスワードが違うみたい。',
  'auth/user-not-found': 'そのメールアドレスは登録されてないみたい。',
  'auth/invalid-email': 'メールアドレスの形がちがうみたい。',
  'auth/weak-password': 'パスワードは6文字以上にしてね。',
  'auth/missing-password': 'パスワードを入れてね。',
  'auth/too-many-requests': '何度も試したみたい。少し時間をおいてね。',
  'auth/requires-recent-login': '安全のため、いったんログインし直してから試してね。',
  'auth/popup-blocked': 'ポップアップがブロックされたみたい。許可してもう一度押してね。',
  'auth/operation-not-allowed': 'このログイン方法はまだ使えないみたい。',
  'auth/network-request-failed': '通信がうまくいかなかったみたい。電波のいいところでもう一度。',
  'permission-denied': 'その操作はできないみたい。'
};
function errMsg(e) {
  if (e && e.code && AUTH_ERRORS[e.code]) return AUTH_ERRORS[e.code];
  const m = e && (e.message || e.details) || String(e);
  if (m.includes('daily_limit_reached')) return '今日の受け取りはここまで。また明日届くよ。';
  if (m.includes('login_required')) return 'この機能はログインが必要だよ。';
  if (m.includes('tracks_must_be_3_to_10')) return '曲は3〜10曲で作ってね。';
  if (m.includes('create_limit_reached')) return '今日流せるセトリはここまで。また明日ね。';
  if (m.includes('setlists_comment_check')) return 'ひとことは100字以内で、URLやSNSのIDは書けないよ。';
  if (m.includes('duplicate key')) return 'もう送信済みだよ。';
  if (m.includes('row-level security')) return 'その操作はできないみたい。';
  return 'うまくいかなかった…（' + m + '）';
}
function Toast({
  text
}) {
  if (!text) return null;
  return React.createElement("div", {
    className: "toast",
    role: "status"
  }, text);
}
function Sheet({
  onClose,
  children
}) {
  return React.createElement("div", {
    className: "overlay",
    onClick: onClose
  }, React.createElement("div", {
    className: "sheet",
    onClick: e => e.stopPropagation()
  }, children));
}
function Confirm({
  title,
  body,
  okLabel,
  danger,
  onOk,
  onCancel
}) {
  return React.createElement(Sheet, {
    onClose: onCancel
  }, React.createElement("h3", null, title), body && React.createElement("p", null, body), React.createElement("div", {
    className: "row"
  }, React.createElement("button", {
    className: "btn ghost",
    onClick: onCancel
  }, "やめる"), React.createElement("button", {
    className: 'btn' + (danger ? ' danger' : ''),
    onClick: onOk
  }, okLabel)));
}
function TrackItem({
  t,
  i
}) {
  const label = t.title || SERVICES[t.service] + ' の曲';
  return React.createElement("li", null, React.createElement("a", {
    className: "trow",
    href: t.url,
    target: "_blank",
    rel: "noopener noreferrer"
  }, React.createElement("span", {
    className: "tno"
  }, String(i + 1).padStart(2, '0')), t.thumbnail && React.createElement("img", {
    className: "tthumb",
    src: t.thumbnail,
    alt: "",
    loading: "lazy",
    referrerPolicy: "no-referrer"
  }), React.createElement("span", {
    className: "meta"
  }, React.createElement("div", {
    className: "title"
  }, label), t.artist && React.createElement("div", {
    className: "artist"
  }, t.artist), React.createElement("div", {
    className: "svc"
  }, SERVICES[t.service], " で開く")), React.createElement("span", {
    className: "play",
    "aria-hidden": "true"
  }, React.createElement("svg", {
    viewBox: "0 0 12 12"
  }, React.createElement("path", {
    d: "M2 1.2v9.6L10.6 6z",
    fill: "currentColor"
  })))));
}
function NeonBottle() {
  return React.createElement("svg", {
    viewBox: "0 0 340 200",
    role: "img",
    "aria-label": "音符の入ったボトルが波間に浮かんでいる"
  }, React.createElement("defs", null, React.createElement("filter", {
    id: "nb-glow",
    x: "-60%",
    y: "-60%",
    width: "220%",
    height: "220%"
  }, React.createElement("feGaussianBlur", {
    stdDeviation: "3.2",
    result: "b"
  }), React.createElement("feMerge", null, React.createElement("feMergeNode", {
    in: "b"
  }), React.createElement("feMergeNode", {
    in: "b"
  }), React.createElement("feMergeNode", {
    in: "SourceGraphic"
  }))), React.createElement("filter", {
    id: "nb-soft",
    x: "-50%",
    y: "-200%",
    width: "200%",
    height: "500%"
  }, React.createElement("feGaussianBlur", {
    stdDeviation: "2",
    result: "b"
  }), React.createElement("feMerge", null, React.createElement("feMergeNode", {
    in: "b"
  }), React.createElement("feMergeNode", {
    in: "SourceGraphic"
  }))), React.createElement("radialGradient", {
    id: "nb-haze",
    cx: "50%",
    cy: "48%",
    r: "45%"
  }, React.createElement("stop", {
    offset: "0",
    stopColor: "#c967e8",
    stopOpacity: ".32"
  }), React.createElement("stop", {
    offset: "1",
    stopColor: "#c967e8",
    stopOpacity: "0"
  }))), React.createElement("rect", {
    width: "340",
    height: "200",
    fill: "url(#nb-haze)"
  }), React.createElement("g", {
    filter: "url(#nb-soft)",
    strokeLinecap: "round",
    fill: "none"
  }, React.createElement("path", {
    d: "M30 156 h70",
    stroke: "#5fd3ff",
    strokeWidth: "2",
    opacity: ".55"
  }), React.createElement("path", {
    d: "M118 156 h24",
    stroke: "#5fd3ff",
    strokeWidth: "2",
    opacity: ".35"
  }), React.createElement("path", {
    d: "M206 158 h96",
    stroke: "#c967e8",
    strokeWidth: "2",
    opacity: ".5"
  }), React.createElement("path", {
    d: "M58 170 h40",
    stroke: "#ff5fb4",
    strokeWidth: "2",
    opacity: ".45"
  }), React.createElement("path", {
    d: "M112 170 h120",
    stroke: "#5fd3ff",
    strokeWidth: "2",
    opacity: ".3"
  }), React.createElement("path", {
    d: "M248 172 h34",
    stroke: "#ff5fb4",
    strokeWidth: "2",
    opacity: ".4"
  }), React.createElement("path", {
    d: "M84 184 h56",
    stroke: "#c967e8",
    strokeWidth: "2",
    opacity: ".3"
  }), React.createElement("path", {
    d: "M168 186 h70",
    stroke: "#5fd3ff",
    strokeWidth: "2",
    opacity: ".22"
  })), React.createElement("g", {
    className: "float"
  }, React.createElement("g", {
    transform: "rotate(-16 170 100)",
    filter: "url(#nb-glow)",
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, React.createElement("rect", {
    x: "158",
    y: "22",
    width: "24",
    height: "12",
    rx: "3",
    stroke: "#ffc25a",
    strokeWidth: "2.4"
  }), React.createElement("path", {
    d: "M161 34 h18 v20 c0 6 4 9 10 13 c14 9 22 22 22 40 v38 c0 9 -7 16 -16 16 h-50 c-9 0 -16 -7 -16 -16 v-38 c0 -18 8 -31 22 -40 c6 -4 10 -7 10 -13 z",
    stroke: "#5fd3ff",
    strokeWidth: "2.6"
  }), React.createElement("path", {
    d: "M136 140 q12 -6 24 0 t24 0 t24 0",
    stroke: "#c967e8",
    strokeWidth: "2",
    opacity: ".9"
  }), React.createElement("path", {
    d: "M178 88 v36",
    stroke: "#ff5fb4",
    strokeWidth: "2.6"
  }), React.createElement("path", {
    d: "M178 88 c9 2 15 7 15 16",
    stroke: "#ff5fb4",
    strokeWidth: "2.6"
  }), React.createElement("ellipse", {
    cx: "171",
    cy: "125",
    rx: "8",
    ry: "6",
    transform: "rotate(-22 171 125)",
    fill: "#ff5fb4",
    stroke: "none"
  }))), React.createElement("g", {
    fill: "none",
    stroke: "#fff",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    filter: "url(#nb-soft)"
  }, React.createElement("path", {
    className: "twinkle",
    d: "M72 52 v12 M66 58 h12",
    stroke: "#ffc25a"
  }), React.createElement("path", {
    className: "twinkle d2",
    d: "M268 40 v10 M263 45 h10"
  }), React.createElement("path", {
    className: "twinkle d3",
    d: "M290 112 v8 M286 116 h8",
    stroke: "#5fd3ff"
  })));
}
function LoginForm({
  user,
  onDone,
  toast
}) {
  const [mode, setMode] = useState('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const run = async fn => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) return;
      toast(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = e => {
    e.preventDefault();
    if (!email.includes('@')) return toast('メールアドレスを入れてね');
    if (mode === 'reset') return run(async () => {
      await api.resetPassword(email.trim());
      setSent(true);
    });
    if (password.length < 6) return toast('パスワードは6文字以上にしてね');
    run(async () => {
      if (mode === 'signup') await api.signUpEmail(email.trim(), password);else await api.signInEmail(email.trim(), password);
      toast('ログインしたよ');
      onDone && onDone();
    });
  };
  const google = () => run(async () => {
    await api.loginGoogle();
    toast('ログインしたよ');
    onDone && onDone();
  });
  if (sent) {
    return React.createElement("div", null, React.createElement("p", {
      className: "hint ok"
    }, "パスワードを作り直すメールを送ったよ。届いたリンクから新しいパスワードを決めてね。"), React.createElement("button", {
      className: "btn ghost",
      onClick: () => {
        setSent(false);
        setMode('login');
      }
    }, "ログインにもどる"));
  }
  return React.createElement("div", null, React.createElement("button", {
    className: "btn social",
    onClick: google,
    disabled: busy
  }, React.createElement("svg", {
    viewBox: "0 0 18 18",
    "aria-hidden": "true"
  }, React.createElement("path", {
    d: "M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z",
    fill: "#4285F4"
  }), React.createElement("path", {
    d: "M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z",
    fill: "#34A853"
  }), React.createElement("path", {
    d: "M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z",
    fill: "#FBBC05"
  }), React.createElement("path", {
    d: "M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z",
    fill: "#EA4335"
  })), "Googleでログイン"), React.createElement("div", {
    className: "or"
  }, React.createElement("span", null, "またはメールで")), React.createElement("div", {
    className: "chips",
    role: "tablist",
    style: {
      marginBottom: 10
    }
  }, React.createElement("button", {
    className: 'chip' + (mode === 'signup' ? ' on' : ''),
    onClick: () => setMode('signup')
  }, "はじめて登録"), React.createElement("button", {
    className: 'chip' + (mode === 'login' ? ' on' : ''),
    onClick: () => setMode('login')
  }, "ログイン")), React.createElement("form", {
    onSubmit: submit
  }, React.createElement("label", {
    className: "field",
    htmlFor: "email",
    style: {
      marginTop: 0
    }
  }, "メールアドレス"), React.createElement("input", {
    id: "email",
    className: "input",
    type: "email",
    autoComplete: "email",
    value: email,
    onChange: e => setEmail(e.target.value),
    placeholder: "you@example.com"
  }), mode !== 'reset' && React.createElement(React.Fragment, null, React.createElement("label", {
    className: "field",
    htmlFor: "pw"
  }, "パスワード（6文字以上）"), React.createElement("input", {
    id: "pw",
    className: "input",
    type: "password",
    value: password,
    autoComplete: mode === 'signup' ? 'new-password' : 'current-password',
    onChange: e => setPassword(e.target.value)
  })), React.createElement("button", {
    className: "btn outline",
    disabled: busy,
    style: {
      marginTop: 12
    }
  }, busy ? '送信中…' : mode === 'signup' ? '登録する' : mode === 'login' ? 'ログインする' : '作り直しメールを送る')), mode === 'login' && React.createElement("p", {
    className: "hint",
    style: {
      textAlign: 'center'
    }
  }, React.createElement("button", {
    className: "linkish",
    onClick: () => setMode('reset')
  }, "パスワードを忘れたとき")), mode === 'reset' && React.createElement("p", {
    className: "hint",
    style: {
      textAlign: 'center'
    }
  }, React.createElement("button", {
    className: "linkish",
    onClick: () => setMode('login')
  }, "ログインにもどる")));
}
function ReceiveTab({
  scenes,
  toast,
  goCreate
}) {
  const [busy, setBusy] = useState(false);
  const [got, setGot] = useState(null);
  const [none, setNone] = useState(null);
  const [stamp, setStamp] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [picked, setPicked] = useState(null);
  const receive = async scene => {
    setBusy(true);
    setNone(null);
    try {
      const data = await api.receive(scene.id);
      if (!data) {
        setNone(scene.name);
        return;
      }
      setGot(data);
      setStamp(null);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const sendStamp = async id => {
    if (stamp) return;
    setStamp(id);
    try {
      await api.stamp(got.setlist_id, id);
    } catch (e) {
      setStamp(null);
      toast(e.code === 'permission-denied' ? 'もう送信済みだよ。' : errMsg(e));
      return;
    }
    toast('作った人にこっそり届けたよ');
  };
  const report = async () => {
    setConfirm(null);
    try {
      await api.report(got.setlist_id);
    } catch (e) {
      return toast(e.code === 'permission-denied' ? 'もう通報済みだよ。' : errMsg(e));
    }
    toast('通報したよ。ありがとう');
  };
  const block = async () => {
    setConfirm(null);
    try {
      await api.block(got.author);
    } catch (e) {
      return toast(errMsg(e));
    }
    toast('この人のセトリはもう届かないよ');
    setGot(null);
  };
  if (got) {
    const n = (got.tracks || []).length;
    return React.createElement("div", null, React.createElement("div", {
      className: "panel"
    }, React.createElement("p", {
      className: "from"
    }, "だれかから、ボトルが届いたよ"), React.createElement("h2", {
      className: "set-title"
    }, got.scene, "のセトリ"), React.createElement("p", {
      className: "set-sub"
    }, "誰かが、この気分のときに聴いてる", n, "曲。"), React.createElement("ul", {
      className: "tracklist"
    }, (got.tracks || []).map((t, i) => React.createElement(TrackItem, {
      key: i,
      t: t,
      i: i
    }))), got.comment && React.createElement("p", {
      className: "quote"
    }, "「", got.comment, "」"), React.createElement("div", {
      className: "react"
    }, React.createElement("p", {
      className: "react-label"
    }, React.createElement("svg", {
      viewBox: "0 0 16 16",
      "aria-hidden": "true"
    }, React.createElement("path", {
      d: "M8 14s-5.5-3.3-5.5-7.2C2.5 4.6 4 3.2 5.7 3.2c1 0 1.8.5 2.3 1.3.5-.8 1.3-1.3 2.3-1.3 1.7 0 3.2 1.4 3.2 3.6C13.5 10.7 8 14 8 14z",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinejoin: "round"
    })), stamp ? '匿名で感想を送ったよ' : '匿名で感想を送る'), React.createElement("div", {
      className: "stamps",
      "aria-label": "スタンプで感想"
    }, STAMPS.map(s => React.createElement("button", {
      key: s.id,
      className: 'stamp' + (stamp === s.id ? ' on' : ''),
      disabled: !!stamp,
      onClick: () => sendStamp(s.id)
    }, s.label))))), React.createElement("div", {
      style: {
        marginTop: 14
      }
    }, React.createElement("button", {
      className: "btn",
      onClick: () => setGot(null)
    }, "別の気分を選ぶ")), React.createElement("div", {
      style: {
        textAlign: 'center',
        marginTop: 10
      }
    }, React.createElement("button", {
      className: "linkish",
      onClick: () => setConfirm('report')
    }, "通報する"), React.createElement("button", {
      className: "linkish",
      onClick: () => setConfirm('block')
    }, "この人をブロック")), confirm === 'report' && React.createElement(Confirm, {
      title: "このセトリを通報する？",
      body: "不適切な内容や迷惑な投稿を見つけたときに使ってね。",
      okLabel: "通報する",
      danger: true,
      onOk: report,
      onCancel: () => setConfirm(null)
    }), confirm === 'block' && React.createElement(Confirm, {
      title: "この人をブロックする？",
      body: "相手が誰かはわからないまま、この人のセトリが届かなくなるよ。",
      okLabel: "ブロックする",
      danger: true,
      onOk: block,
      onCancel: () => setConfirm(null)
    }));
  }
  const toMoods = () => document.getElementById('moods')?.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });
  return React.createElement("div", null, React.createElement("section", {
    className: "panel"
  }, React.createElement("div", {
    className: "hero-art"
  }, React.createElement(NeonBottle, null)), React.createElement("h2", {
    className: "hero-title"
  }, "今の気分に、誰かのセトリを。"), React.createElement("p", {
    className: "hero-sub"
  }, "気分を選ぶと、同じ気分のときに誰かが聴いてる曲が、ボトルに入って届くよ。"), React.createElement("div", {
    className: "stack"
  }, React.createElement("button", {
    className: "btn",
    onClick: toMoods
  }, "セトリを受け取る"), React.createElement("button", {
    className: "btn outline",
    onClick: goCreate
  }, "セトリを作って届ける"))), React.createElement("h3", {
    className: "sec",
    id: "moods"
  }, "いまの気分は？"), React.createElement("div", {
    className: "moods",
    role: "radiogroup",
    "aria-label": "いまの気分"
  }, scenes.map((s, i) => React.createElement("button", {
    key: s.id,
    className: 'mood' + (picked && picked.id === s.id ? ' on' : ''),
    disabled: busy,
    role: "radio",
    "aria-checked": !!picked && picked.id === s.id,
    onClick: () => {
      setPicked(p => p && p.id === s.id ? null : s);
      setNone(null);
    },
    style: {
      '--c': TUBES[i % TUBES.length]
    }
  }, React.createElement("b", null, s.name)))), React.createElement("div", {
    className: "receive-bar"
  }, React.createElement("button", {
    className: "btn",
    disabled: !picked || busy,
    onClick: () => receive(picked)
  }, busy ? 'ボトルを探してるよ…' : picked ? `「${picked.name}」のセトリを受け取る` : '気分を選んでね')), none && React.createElement("div", {
    className: "card empty",
    style: {
      marginTop: 14
    }
  }, "「", none, "」のセトリは、今はもう届けられるものがないみたい。", React.createElement("br", null), "あなたのセトリを流してみない？"));
}
const emptyTrack = () => ({
  url: '',
  title: '',
  artist: '',
  thumbnail: '',
  service: null,
  loading: false
});
function CreateTab({
  user,
  scenes,
  toast,
  onCreated,
  openLogin,
  guestCanCreate
}) {
  const [sceneId, setSceneId] = useState(null);
  const [tracks, setTracks] = useState([emptyTrack(), emptyTrack(), emptyTrack()]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  if (user ? user.is_anonymous && !guestCanCreate : !guestCanCreate) {
    return React.createElement("div", null, React.createElement("h2", null, "セトリを流す"), React.createElement("div", {
      className: "card"
    }, React.createElement("p", {
      style: {
        marginTop: 0
      }
    }, "セトリを作るにはログインが必要だよ。Googleかメールアドレスで登録できる。"), React.createElement("button", {
      className: "btn",
      onClick: openLogin
    }, "ログインする")));
  }
  const update = (i, patch) => setTracks(ts => ts.map((t, j) => j === i ? {
    ...t,
    ...patch
  } : t));
  const onUrlBlur = async i => {
    const t = tracks[i];
    const service = detectService(t.url);
    update(i, {
      service
    });
    if (!service || t.title || t.loading) return;
    update(i, {
      loading: true
    });
    const meta = await fetchMeta(t.url.trim(), service);
    setTracks(ts => ts.map((x, j) => j !== i ? x : {
      ...x,
      loading: false,
      title: x.title || meta.title || '',
      artist: x.artist || meta.artist || '',
      thumbnail: meta.thumbnail || ''
    }));
  };
  const filled = tracks.filter(t => t.url.trim());
  const allValid = filled.every(t => detectService(t.url));
  const canSubmit = sceneId && filled.length >= 3 && filled.length <= 10 && allValid && !busy;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const payload = filled.map(t => ({
        url: t.url.trim(),
        service: detectService(t.url),
        title: t.title.trim() || null,
        artist: t.artist.trim() || null,
        thumbnail: t.thumbnail || null
      }));
      await api.createSetlist(sceneId, comment, payload);
      toast('セトリを流したよ。誰かに届きますように');
      setSceneId(null);
      setTracks([emptyTrack(), emptyTrack(), emptyTrack()]);
      setComment('');
      onCreated();
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return React.createElement("div", null, React.createElement("h2", null, "セトリを流す"), (!user || user.is_anonymous) && React.createElement("p", {
    className: "hint",
    style: {
      marginTop: -4
    }
  }, "ゲストのままでも流せるよ。ただ、ゲストで流したセトリはこの端末のこのブラウザでしか見返せないから、 残したいなら", React.createElement("button", {
    className: "linkish",
    style: {
      padding: 0
    },
    onClick: openLogin
  }, "ログイン"), "がおすすめ。"), React.createElement("label", {
    className: "field"
  }, "どんなときに聴く？"), React.createElement("div", {
    className: "chips"
  }, scenes.map(s => React.createElement("button", {
    key: s.id,
    className: 'chip' + (sceneId === s.id ? ' on' : ''),
    onClick: () => setSceneId(s.id)
  }, s.name))), React.createElement("label", {
    className: "field"
  }, "曲のリンク（3〜10曲）"), tracks.map((t, i) => {
    const bad = t.url.trim() && !detectService(t.url);
    return React.createElement("div", {
      className: "trackrow",
      key: i
    }, React.createElement("div", {
      className: "num"
    }, React.createElement("span", null, React.createElement("span", {
      className: "tno"
    }, String(i + 1).padStart(2, '0')), " ", t.service && React.createElement("span", {
      className: "hint ok"
    }, SERVICES[t.service])), tracks.length > 3 && React.createElement("button", {
      className: "linkish",
      onClick: () => setTracks(ts => ts.filter((_, j) => j !== i))
    }, "削除")), React.createElement("input", {
      className: "input",
      inputMode: "url",
      placeholder: "YouTube / Spotify / Apple Music / Amazon Music のリンク",
      value: t.url,
      onChange: e => update(i, {
        url: e.target.value,
        service: null,
        title: '',
        artist: '',
        thumbnail: ''
      }),
      onBlur: () => onUrlBlur(i)
    }), React.createElement("div", {
      className: "meta-row"
    }, t.thumbnail && React.createElement("img", {
      className: "tthumb",
      src: t.thumbnail,
      alt: "",
      referrerPolicy: "no-referrer"
    }), React.createElement("div", {
      className: "meta-inputs"
    }, React.createElement("input", {
      className: "input",
      placeholder: t.loading ? '曲名を探してるよ…' : '曲名（自動で入るよ）',
      value: t.title,
      maxLength: 200,
      onChange: e => update(i, {
        title: e.target.value
      })
    }), React.createElement("input", {
      className: "input",
      placeholder: t.loading ? 'アーティストを探してるよ…' : 'アーティスト名（自動で入るよ）',
      value: t.artist,
      maxLength: 200,
      onChange: e => update(i, {
        artist: e.target.value
      })
    }))), bad && React.createElement("p", {
      className: "hint err"
    }, "対応してないリンクみたい。共有ボタンからコピーしたリンクを貼ってね。"));
  }), tracks.length < 10 && React.createElement("button", {
    className: "btn ghost",
    onClick: () => setTracks(ts => [...ts, emptyTrack()])
  }, "＋ 曲を追加"), React.createElement("label", {
    className: "field",
    htmlFor: "comment"
  }, "ひとこと（任意）"), React.createElement("textarea", {
    id: "comment",
    className: "input",
    maxLength: 100,
    value: comment,
    onChange: e => setComment(e.target.value),
    placeholder: "例：駅まで歩くときに聴いてる"
  }), React.createElement("p", {
    className: "hint"
  }, comment.length, " / 100\u3000URLやSNSのID、歌詞は書かないでね"), React.createElement("div", {
    style: {
      marginTop: 16
    }
  }, React.createElement("button", {
    className: "btn",
    disabled: !canSubmit,
    onClick: submit
  }, busy ? '流しています…' : 'このセトリを流す'), !sceneId && React.createElement("p", {
    className: "hint"
  }, "シーンを選んでね"), sceneId && filled.length < 3 && React.createElement("p", {
    className: "hint"
  }, "あと", 3 - filled.length, "曲入れてね")));
}
function MeTab({
  user,
  toast,
  reloadKey,
  openLogin,
  openRules
}) {
  const [list, setList] = useState(null);
  const [del, setDel] = useState(null);
  const [tracksBy, setTracksBy] = useState({});
  const [open, setOpen] = useState({});
  const guest = !user || user.is_anonymous;
  const load = useCallback(async () => {
    if (!user) {
      setList([]);
      return;
    }
    try {
      const data = await api.mySetlists();
      setList(data);
      const by = {};
      for (const s of data) by[s.setlist_id] = s.tracks;
      setTracksBy(by);
    } catch (e) {
      toast(errMsg(e));
      setList([]);
    }
  }, [user && user.id]);
  useEffect(() => {
    load();
  }, [load, reloadKey]);
  const remove = async () => {
    const id = del;
    setDel(null);
    try {
      await api.deleteSetlist(id);
    } catch (e) {
      return toast(errMsg(e));
    }
    toast('セトリを削除したよ');
    load();
  };
  const logout = async () => {
    await auth.signOut();
  };
  const [bye, setBye] = useState(false);
  const [byePw, setByePw] = useState('');
  const [byeBusy, setByeBusy] = useState(false);
  const usesPassword = !!(auth.currentUser && auth.currentUser.providerData.some(p => p.providerId === 'password'));
  const deleteAccount = async () => {
    setByeBusy(true);
    try {
      await api.deleteAccount(byePw);
      setBye(false);
      setByePw('');
      toast('アカウントを削除したよ。今までありがとう');
    } catch (e) {
      if (!(e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request'))) toast(errMsg(e));
    } finally {
      setByeBusy(false);
    }
  };
  return React.createElement("div", null, React.createElement("h2", null, "アカウント"), React.createElement("div", {
    className: "card"
  }, guest ? React.createElement("div", null, React.createElement("p", {
    style: {
      marginTop: 0
    }
  }, "今はゲストで使ってるよ。ログインするとセトリを作ったり、届いた感想を見たりできる。"), React.createElement("button", {
    className: "btn",
    onClick: openLogin
  }, "ログインする")) : React.createElement("div", {
    className: "mine-head"
  }, React.createElement("span", {
    style: {
      wordBreak: 'break-all'
    }
  }, user.email), React.createElement("button", {
    className: "btn ghost small",
    onClick: logout
  }, "ログアウト"))), (!guest || list && list.length > 0) && React.createElement(React.Fragment, null, React.createElement("h2", null, "あなたが流したセトリ"), guest && React.createElement("p", {
    className: "hint",
    style: {
      marginTop: -4
    }
  }, "ゲストで流したセトリは、このブラウザを使い続けている間だけ見られるよ。"), list === null && React.createElement("div", {
    className: "loading",
    style: {
      padding: 20
    }
  }, "読み込み中…"), list && list.length === 0 && React.createElement("div", {
    className: "card empty"
  }, "まだセトリがないよ。「作る」から流してみよう。"), list && list.map(s => React.createElement("div", {
    className: "card",
    key: s.setlist_id
  }, React.createElement("div", {
    className: "mine-head"
  }, React.createElement("span", {
    className: "tag"
  }, s.scene), React.createElement("button", {
    className: "linkish",
    onClick: () => setDel(s.setlist_id)
  }, "削除")), s.comment && React.createElement("div", {
    className: "note"
  }, s.comment), tracksBy[s.setlist_id] && React.createElement(React.Fragment, null, React.createElement("button", {
    className: "toggle",
    "aria-expanded": !!open[s.setlist_id],
    onClick: () => setOpen(o => ({
      ...o,
      [s.setlist_id]: !o[s.setlist_id]
    }))
  }, open[s.setlist_id] ? '曲を閉じる' : `曲を見る（${tracksBy[s.setlist_id].length}曲）`), open[s.setlist_id] && React.createElement("ul", {
    className: "tracklist"
  }, tracksBy[s.setlist_id].map((t, i) => React.createElement(TrackItem, {
    key: i,
    t: t,
    i: i
  })))), React.createElement("div", {
    className: "hint",
    style: {
      marginTop: 10
    }
  }, s.deliveries, "人に届いた", s.hidden && '　・通報が多かったため、今は届けられていないよ'), React.createElement("div", {
    className: "counts"
  }, STAMPS.filter(st => s.stamps && s.stamps[st.id]).map(st => React.createElement("span", {
    className: "count",
    key: st.id
  }, st.label, React.createElement("b", null, s.stamps[st.id]))), (!s.stamps || Object.keys(s.stamps).length === 0) && React.createElement("span", {
    className: "hint"
  }, "まだスタンプはないよ"))))), !guest && React.createElement("div", {
    style: {
      textAlign: 'center',
      marginTop: 28
    }
  }, React.createElement("button", {
    className: "linkish",
    style: {
      color: 'var(--danger)'
    },
    onClick: () => setBye(true)
  }, "アカウントを削除する")), React.createElement("footer", {
    className: "foot"
  }, React.createElement("button", {
    className: "linkish",
    onClick: openRules
  }, "利用のきまり"), React.createElement("a", {
    className: "linkish",
    href: "privacy.html"
  }, "プライバシーポリシー")), bye && React.createElement(Sheet, {
    onClose: () => !byeBusy && setBye(false)
  }, React.createElement("h3", null, "アカウントを削除する？"), React.createElement("p", null, "流したセトリ、届いたスタンプ、受け取った記録がすべて消えて、元に戻せないよ。", usesPassword ? '確認のため、パスワードを入れてね。' : '確認のため、もう一度Googleでログインしてもらうよ。'), usesPassword && React.createElement("input", {
    className: "input",
    type: "password",
    autoComplete: "current-password",
    placeholder: "パスワード",
    value: byePw,
    onChange: e => setByePw(e.target.value),
    style: {
      marginBottom: 12
    }
  }), React.createElement("div", {
    className: "row"
  }, React.createElement("button", {
    className: "btn ghost",
    disabled: byeBusy,
    onClick: () => setBye(false)
  }, "やめる"), React.createElement("button", {
    className: "btn danger",
    disabled: byeBusy || usesPassword && !byePw,
    onClick: deleteAccount
  }, byeBusy ? '削除中…' : '削除する'))), del && React.createElement(Confirm, {
    title: "このセトリを削除する？",
    body: "届いたスタンプも一緒に消えて、元に戻せないよ。",
    okLabel: "削除する",
    danger: true,
    onOk: remove,
    onCancel: () => setDel(null)
  }));
}
function Rules({
  onClose
}) {
  return React.createElement(Sheet, {
    onClose: onClose
  }, React.createElement("h3", null, "利用のきまり"), React.createElement("ul", null, React.createElement("li", null, "悪口、誹謗中傷、差別的な内容は禁止"), React.createElement("li", null, "住所・電話番号・SNSのIDなど、個人を特定できる情報は書かない"), React.createElement("li", null, "出会い目的や勧誘、宣伝のための利用は禁止"), React.createElement("li", null, "曲は公式サービスのリンクだけを載せてね（違法アップロードのリンクは禁止）"), React.createElement("li", null, "歌詞は著作物なので、ひとことや紹介文に歌詞を書き写さないでね（曲名やアーティスト名の紹介はOK）"), React.createElement("li", null, "きまりに反する投稿は、運営が予告なく非表示・削除することがあります")), React.createElement("p", {
    style: {
      fontSize: 13
    }
  }, React.createElement("b", null, "権利者の方へ"), "：掲載内容に権利上の問題がある場合は、", React.createElement("a", {
    href: "mailto:qx042039711@gmail.com"
  }, "qx042039711@gmail.com"), " までご連絡ください。確認のうえ、速やかに非表示・削除などの対応をします。"), React.createElement("button", {
    className: "btn ghost",
    onClick: onClose
  }, "閉じる"));
}
function App() {
  const [user, setUser] = useState(undefined);
  const scenes = SCENES;
  const guestCanCreate = GUEST_CAN_CREATE;
  const [tab, setTab] = useState('receive');
  const [toastText, setToastText] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [fatal, setFatal] = useState('');
  const toast = useCallback(t => {
    setToastText(t);
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => setToastText(''), 3200);
  }, []);
  useEffect(() => {
    const unsub = auth.onAuthStateChanged(u => {
      setUser(toUser(u));
      if (u && !u.isAnonymous) setLoginOpen(false);
    });
    const refresh = () => {
      const u = auth.currentUser;
      setUser(toUser(u));
      if (u && !u.isAnonymous) setLoginOpen(false);
    };
    window.addEventListener('authchange', refresh);
    return () => {
      unsub();
      window.removeEventListener('authchange', refresh);
    };
  }, []);
  if (user === undefined) return React.createElement("div", {
    className: "loading"
  }, "読み込み中…");
  const guest = !user || user.is_anonymous;
  return React.createElement("div", {
    className: "app"
  }, React.createElement("header", {
    className: "top"
  }, React.createElement("div", {
    className: "logo"
  }, React.createElement("svg", {
    viewBox: "0 0 34 18",
    "aria-hidden": "true"
  }, React.createElement("path", {
    d: "M1 9 q4 -7 8 0 t8 0 t8 0 t8 0",
    fill: "none",
    stroke: "#5fd3ff",
    strokeWidth: "2",
    strokeLinecap: "round",
    style: {
      filter: 'drop-shadow(0 0 3px #5fd3ff)'
    }
  })), React.createElement("div", null, React.createElement("h1", null, "音届便"), React.createElement("span", {
    className: "kana"
  }, "おとどけびん"))), React.createElement("button", {
    className: "who",
    onClick: () => guest ? setLoginOpen(true) : setTab('me')
  }, guest ? 'ゲスト・ログイン' : 'ログイン中')), fatal && React.createElement("div", {
    className: "card",
    style: {
      borderColor: 'var(--danger)'
    }
  }, React.createElement("p", {
    className: "hint err",
    style: {
      margin: 0
    }
  }, fatal)), tab === 'receive' && React.createElement(ReceiveTab, {
    scenes: scenes,
    toast: toast,
    goCreate: () => setTab('create')
  }), tab === 'create' && React.createElement(CreateTab, {
    user: user,
    scenes: scenes,
    toast: toast,
    guestCanCreate: guestCanCreate,
    openLogin: () => setLoginOpen(true),
    onCreated: () => {
      setReloadKey(k => k + 1);
      setTab('me');
    }
  }), tab === 'me' && React.createElement(MeTab, {
    user: user,
    toast: toast,
    reloadKey: reloadKey,
    openLogin: () => setLoginOpen(true),
    openRules: () => setRulesOpen(true)
  }), React.createElement("nav", {
    className: "tabs",
    "aria-label": "メニュー"
  }, React.createElement("div", {
    className: "inner"
  }, React.createElement("button", {
    className: tab === 'receive' ? 'on' : '',
    onClick: () => setTab('receive')
  }, React.createElement("svg", {
    className: "ico",
    viewBox: "0 0 24 24",
    "aria-hidden": "true"
  }, React.createElement("path", {
    d: "M9 3h6v2.5c0 1 .6 1.7 1.6 2.4C18.3 9 19 10.7 19 13v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5c0-2.3.7-4 2.4-5.1 1-.7 1.6-1.4 1.6-2.4z"
  }), React.createElement("path", {
    d: "M8 15c1.3-.8 2.7-.8 4 0s2.7.8 4 0"
  })), "受け取る"), React.createElement("button", {
    className: tab === 'create' ? 'on' : '',
    onClick: () => setTab('create')
  }, React.createElement("svg", {
    className: "ico",
    viewBox: "0 0 24 24",
    "aria-hidden": "true"
  }, React.createElement("path", {
    d: "M9 18V6l10-2v12"
  }), React.createElement("circle", {
    cx: "6.5",
    cy: "18",
    r: "2.5"
  }), React.createElement("circle", {
    cx: "16.5",
    cy: "16",
    r: "2.5"
  })), "作る"), React.createElement("button", {
    className: tab === 'me' ? 'on' : '',
    onClick: () => setTab('me')
  }, React.createElement("svg", {
    className: "ico",
    viewBox: "0 0 24 24",
    "aria-hidden": "true"
  }, React.createElement("circle", {
    cx: "12",
    cy: "8.5",
    r: "3.5"
  }), React.createElement("path", {
    d: "M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"
  })), "じぶん"))), loginOpen && React.createElement(Sheet, {
    onClose: () => setLoginOpen(false)
  }, React.createElement("h3", null, "ログイン"), React.createElement("p", null, "ゲストで使っていた記録は、はじめての登録なら引き継がれるよ。"), React.createElement(LoginForm, {
    user: user,
    toast: toast,
    onDone: () => setLoginOpen(false)
  })), rulesOpen && React.createElement(Rules, {
    onClose: () => setRulesOpen(false)
  }), React.createElement(Toast, {
    text: toastText
  }));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App, null));
})();
