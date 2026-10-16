import { db } from "./firebase.js";
import { ICE_SERVERS } from "./config.js";

import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  collection,
  addDoc,
  query,
  where,
  orderBy,
  limitToLast
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

/* ---------- Configuración ---------- */

const HEARTBEAT_MS = 15000;
const STALE_AFTER_MS = 50000;
const GUEST_CONNECT_TIMEOUT_MS = 30000;
const GUEST_DISCONNECT_GRACE_MS = 8000;
const AUDIO_MAX_BITRATE = 256000;
const CHAT_HISTORY_LIMIT = 150;

const QUALITY_PRESETS = {
  movie:{
    label:"Película",
    contentHint:"motion",
    degradationPreference:"maintain-framerate",
    width:1920,
    height:1080,
    frameRate:60,
    maxBitrate:10000000
  },
  work:{
    label:"Trabajo",
    contentHint:"detail",
    degradationPreference:"maintain-resolution",
    width:2560,
    height:1440,
    frameRate:30,
    maxBitrate:12000000
  }
};

const STAGE_MESSAGES = {
  idle:{
    icon:"🖥️",
    title:"Comparte o mira una pantalla",
    text:"Escribe el código de una sala para unirte, o crea una para transmitir tu pantalla con audio."
  },
  waiting:{
    icon:"⏳",
    title:"Esperando la transmisión",
    text:"Te conectarás automáticamente cuando el anfitrión empiece a compartir."
  },
  connecting:{
    icon:"📡",
    title:"Conectando…",
    text:"Estableciendo la conexión con el anfitrión."
  },
  reconnecting:{
    icon:"🔄",
    title:"Reconectando…",
    text:"Se perdió la conexión, reintentando automáticamente."
  },
  ended:{
    icon:"⏹️",
    title:"La transmisión terminó",
    text:"Puedes quedarte aquí: si el anfitrión vuelve a transmitir en esta sala, te reconectarás solo."
  }
};

const TURN_HINT = "No logramos conectar. Si alguno de los dos está en una red corporativa o con firewall, puede hacer falta un servidor TURN (config.js).";

/* ---------- Elementos ---------- */

const video = document.getElementById("video");
const stage = document.getElementById("stage");
const hostBtn = document.getElementById("host");
const joinBtn = document.getElementById("join");
const roomInput = document.getElementById("roomInput");
const nameInput = document.getElementById("nameInput");
const lobby = document.getElementById("lobby");
const lobbyHint = document.getElementById("lobbyHint");
const sessionBar = document.getElementById("sessionBar");
const sessionRole = document.getElementById("sessionRole");
const sessionCode = document.getElementById("sessionCode");
const roomLink = document.getElementById("roomLink");
const copyBtn = document.getElementById("copyBtn");
const shareBtn = document.getElementById("shareBtn");
const hostTools = document.getElementById("hostTools");
const switchSourceBtn = document.getElementById("switchSourceBtn");
const leaveBtn = document.getElementById("leaveBtn");
const sidebar = document.getElementById("sidebar");
const roomStatus = document.getElementById("roomStatus");
const liveDot = document.getElementById("liveDot");
const liveChip = document.getElementById("liveChip");
const liveText = document.getElementById("liveText");
const participantCount = document.getElementById("participantCount");
const statsChip = document.getElementById("statsChip");
const placeholder = document.getElementById("placeholder");
const placeholderIcon = document.getElementById("placeholderIcon");
const placeholderTitle = document.getElementById("placeholderTitle");
const placeholderText = document.getElementById("placeholderText");
const unmuteBtn = document.getElementById("unmuteBtn");
const audioControls = document.getElementById("audioControls");
const muteBtn = document.getElementById("muteBtn");
const volumeRange = document.getElementById("volumeRange");
const pipBtn = document.getElementById("pipBtn");
const cleanBtn = document.getElementById("cleanBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const participantsList = document.getElementById("participantsList");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const unreadBadge = document.getElementById("unreadBadge");
const toast = document.getElementById("toast");
const tabButtons = document.querySelectorAll(".tab");
const qualityButtons = document.querySelectorAll("[data-quality]");

/* ---------- Estado ---------- */

const urlParams = new URLSearchParams(window.location.search);
const roomFromUrl = normalizeRoomId(urlParams.get("room"));
const autoJoin = urlParams.get("auto") === "1";
const startClean = urlParams.get("clean") === "1";
const browserSessionId = getStoredSessionId();

let currentRoomId = "";
let currentMode = "idle";
let currentHostName = "";
let localDisplayName = getStoredName();
let qualityMode = getStoredQualityMode();
let preferMuted = storageGet(localStorage, "screenshare-muted") === "1";
let preferVolume = Number(storageGet(localStorage, "screenshare-volume") || 1);

let hostStream = null;
let hostSessionKey = "";
let hostParticipantRef = null;
let hostPeers = new Map();
let retiredGuests = new Set();
let announcedGuests = new Set();

let guestSessionKey = "";
let guestParticipantRef = null;
let guestPeer = null;
let guestOfferNonce = "";
let guestUnsubs = [];
let guestAttempts = 0;
let guestRetryTimer = null;
let guestWatchdogTimer = null;
let guestDisconnectTimer = null;
let remoteStream = null;
let roomIsLive = false;

let roomUnsubs = [];
let participantsUnsub = null;
let participantsCache = [];
let participantSeenAt = new Map();
let messagesLoaded = false;
let unreadCount = 0;
let activeTab = "chat";

let heartbeatTimer = null;
let statsTimer = null;
let lastStatsSample = null;
let wakeLock = null;
let toastTimer = null;
let stageUiTimer = null;
let busy = false;

/* ---------- Utilidades ---------- */

function storageGet(storage, key){
  try{
    return storage.getItem(key) || "";
  }
  catch{
    return "";
  }
}

function storageSet(storage, key, value){
  try{
    storage.setItem(key, value);
  }
  catch{}
}

function getStoredSessionId(){
  const key = "screenshare-session-id";
  const stored = storageGet(sessionStorage, key);

  if(stored){
    return stored;
  }

  const fresh = crypto.randomUUID();
  storageSet(sessionStorage, key, fresh);
  return fresh;
}

function getStoredName(){
  return storageGet(localStorage, "screenshare-name") || storageGet(sessionStorage, "screenshare-name");
}

function getStoredQualityMode(){
  const stored = storageGet(localStorage, "screenshare-quality");
  return QUALITY_PRESETS[stored] ? stored : "movie";
}

function saveName(name){
  const clean = normalizeName(name);

  if(clean){
    storageSet(localStorage, "screenshare-name", clean);
    localDisplayName = clean;
  }

  nameInput.value = clean || localDisplayName;
  return clean || localDisplayName;
}

function normalizeName(name){
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

function getDefaultName(mode){
  return mode === "host"
    ? "Anfitrión"
    : `Invitado-${browserSessionId.slice(0, 4).toUpperCase()}`;
}

// Acepta un código suelto o un enlace completo con ?room=
function normalizeRoomId(value){
  let text = String(value || "").trim();
  const match = text.match(/[?&]room=([^&#\s]+)/i);

  if(match){
    try{
      text = decodeURIComponent(match[1]);
    }
    catch{
      text = match[1];
    }
  }

  return text.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
}

function generateRoomId(){
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte)=>alphabet[byte % alphabet.length]).join("");
}

function generateId(){
  return crypto.randomUUID();
}

function safeCall(fn){
  try{
    fn?.();
  }
  catch{}
}

function formatBitrate(bitsPerSecond){
  return bitsPerSecond >= 1000000
    ? `${(bitsPerSecond / 1000000).toFixed(1)} Mbps`
    : `${Math.round(bitsPerSecond / 1000)} kbps`;
}

function formatTime(timestamp){
  if(!timestamp){
    return "";
  }

  return new Date(timestamp).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}

function canCaptureScreen(){
  return Boolean(navigator.mediaDevices?.getDisplayMedia);
}

function isUserCancel(error){
  return error?.name === "NotAllowedError" || error?.name === "AbortError";
}

/* ---------- Interfaz ---------- */

function showToast(message){
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toast.classList.remove("is-visible"), 2800);
}

function setRoomStatus(message){
  roomStatus.textContent = message;
}

function setLive(state, text){
  liveDot.dataset.state = state;
  liveChip.dataset.state = state;
  liveText.textContent = text;
}

function setStage(key, overrideText = ""){
  if(!key){
    placeholder.hidden = true;
    return;
  }

  const message = STAGE_MESSAGES[key];
  placeholderIcon.textContent = message.icon;
  placeholderTitle.textContent = message.title;
  placeholderText.textContent = overrideText || message.text;
  placeholder.hidden = false;
}

function setMode(mode){
  currentMode = mode;
  document.body.dataset.mode = mode;
  lobby.hidden = mode !== "idle";
  sessionBar.hidden = mode === "idle";
  sidebar.hidden = mode === "idle";
  hostTools.hidden = mode !== "host";
  audioControls.hidden = mode !== "guest";
  sessionRole.textContent = mode === "host" ? "Transmitiendo en la sala" : "Viendo la sala";
  leaveBtn.textContent = mode === "host" ? "⏹ Terminar" : "Salir";
}

function setBusy(value){
  busy = value;
  joinBtn.disabled = value;
  hostBtn.disabled = value || !canCaptureScreen();
}

function updateLobbyButtons(){
  const hasRoom = Boolean(normalizeRoomId(roomInput.value));
  joinBtn.className = hasRoom ? "primary" : "secondary";
  hostBtn.className = hasRoom ? "secondary" : "primary";
  hostBtn.textContent = hasRoom ? "Transmitir en esta sala" : "＋ Crear sala y transmitir";
}

function buildRoomLink(roomId){
  return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
}

function updateUrl(roomId){
  const url = new URL(window.location.href);

  if(roomId){
    url.searchParams.set("room", roomId);
  }
  else{
    url.searchParams.delete("room");
    url.searchParams.delete("auto");
  }

  history.replaceState(null, "", url);
}

function enterRoomUi(roomId){
  roomInput.value = roomId;
  roomLink.value = buildRoomLink(roomId);
  sessionCode.textContent = roomId;
  document.title = `${roomId} · ScreenShare`;
  updateUrl(roomId);

  if(startClean){
    setCleanMode(true);
  }
}

function renderQualityButtons(){
  qualityButtons.forEach((button)=>{
    const active = button.dataset.quality === qualityMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function isCleanMode(){
  return document.body.classList.contains("clean-mode");
}

function setCleanMode(enabled){
  document.body.classList.toggle("clean-mode", enabled);
  cleanBtn.setAttribute("aria-pressed", String(enabled));
  renderUnread();
}

function toggleFullscreen(){
  if(document.fullscreenElement){
    document.exitFullscreen().catch(()=>{});
    return;
  }

  if(stage.requestFullscreen){
    stage.requestFullscreen().catch(()=>{});
  }
  else if(video.webkitEnterFullscreen){
    video.webkitEnterFullscreen();
  }
}

async function togglePictureInPicture(){
  try{
    if(document.pictureInPictureElement){
      await document.exitPictureInPicture();
    }
    else{
      await video.requestPictureInPicture();
    }
  }
  catch(error){
    console.log(error);
    showToast("Imagen en imagen no está disponible ahora");
  }
}

function pokeStageUi(){
  stage.classList.add("show-ui");
  clearTimeout(stageUiTimer);
  stageUiTimer = setTimeout(()=>stage.classList.remove("show-ui"), 2500);
}

function setTab(name){
  activeTab = name;

  tabButtons.forEach((button)=>{
    button.classList.toggle("active", button.dataset.tab === name);
  });

  document.getElementById("chatView").classList.toggle("active", name === "chat");
  document.getElementById("usersView").classList.toggle("active", name !== "chat");

  if(name === "chat"){
    unreadCount = 0;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  renderUnread();
}

function isChatVisible(){
  return currentMode !== "idle" && !isCleanMode() && activeTab === "chat";
}

function renderUnread(){
  if(isChatVisible()){
    unreadCount = 0;
  }

  unreadBadge.hidden = unreadCount === 0;
  unreadBadge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
}

/* ---------- Audio y video local ---------- */

function renderAudioControls(){
  const silent = video.muted || video.volume === 0;
  muteBtn.classList.toggle("is-muted", silent);
  muteBtn.setAttribute("aria-label", silent ? "Activar sonido" : "Silenciar");
  volumeRange.value = String(video.muted ? 0 : video.volume);
}

function setMuted(muted){
  preferMuted = muted;
  storageSet(localStorage, "screenshare-muted", muted ? "1" : "0");
  video.muted = muted;

  if(!muted){
    if(video.volume === 0){
      video.volume = preferVolume || 1;
    }

    unmuteBtn.hidden = true;
    video.play().catch(()=>{});
  }

  renderAudioControls();
}

function showLocalPreview(){
  video.srcObject = hostStream;
  video.muted = true;
  video.play().catch(()=>{});
}

function attachRemoteStream(){
  if(video.srcObject !== remoteStream){
    video.srcObject = remoteStream;
  }

  playRemoteVideo();
}

// Los navegadores bloquean el autoplay con sonido sin interacción previa
// (p. ej. al entrar con ?auto=1). En ese caso arranca en silencio y ofrece activarlo.
async function playRemoteVideo(){
  video.muted = preferMuted;
  video.volume = preferVolume;

  try{
    await video.play();
    unmuteBtn.hidden = true;
  }
  catch(error){
    if(error.name === "AbortError"){
      return;
    }

    video.muted = true;

    try{
      await video.play();
    }
    catch{}

    unmuteBtn.hidden = preferMuted;
  }

  renderAudioControls();
}

async function requestWakeLock(){
  if(!("wakeLock" in navigator) || wakeLock || document.visibilityState !== "visible"){
    return;
  }

  try{
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", ()=>{
      wakeLock = null;
    });
  }
  catch{}
}

function releaseWakeLock(){
  wakeLock?.release().catch(()=>{});
  wakeLock = null;
}

/* ---------- Captura y calidad ---------- */

async function captureScreen(){
  const preset = QUALITY_PRESETS[qualityMode];
  const options = {
    video:{
      width:{ max:preset.width },
      height:{ max:preset.height },
      frameRate:{ ideal:preset.frameRate, max:preset.frameRate }
    },
    audio:{
      echoCancellation:false,
      noiseSuppression:false,
      autoGainControl:false,
      suppressLocalAudioPlayback:false
    },
    systemAudio:"include",
    surfaceSwitching:"include",
    selfBrowserSurface:"exclude"
  };

  try{
    return await navigator.mediaDevices.getDisplayMedia(options);
  }
  catch(error){
    if(isUserCancel(error)){
      throw error;
    }

    console.log("Restricciones no soportadas, usando captura básica", error);
    return navigator.mediaDevices.getDisplayMedia({ video:true, audio:true });
  }
}

function applyQualityToStream(stream){
  const preset = QUALITY_PRESETS[qualityMode];
  const track = stream?.getVideoTracks()[0];

  if(!track){
    return;
  }

  try{
    track.contentHint = preset.contentHint;
  }
  catch{}

  track.applyConstraints({
    width:{ max:preset.width },
    height:{ max:preset.height },
    frameRate:{ ideal:preset.frameRate, max:preset.frameRate }
  }).catch(()=>{});
}

function writeSenderParameters(parameters, kind, withDegradation){
  const preset = QUALITY_PRESETS[qualityMode];
  const encoding = parameters.encodings[0];

  if(kind === "video"){
    encoding.maxBitrate = preset.maxBitrate;
    encoding.maxFramerate = preset.frameRate;
    encoding.scaleResolutionDownBy = 1;

    if(withDegradation){
      parameters.degradationPreference = preset.degradationPreference;
    }
  }
  else{
    encoding.maxBitrate = AUDIO_MAX_BITRATE;
  }

  return parameters;
}

async function tuneSender(sender, kind){
  if(!sender?.track){
    return;
  }

  const attempt = async(withDegradation)=>{
    const parameters = sender.getParameters();

    if(!parameters.encodings?.length){
      return;
    }

    await sender.setParameters(writeSenderParameters(parameters, kind, withDegradation));
  };

  try{
    await attempt(true);
  }
  catch{
    // Algunos navegadores no aceptan degradationPreference: reintenta sin ella.
    try{
      await attempt(false);
    }
    catch(error){
      console.log("No se pudieron fijar los parámetros de envío", error);
    }
  }
}

async function applySenderParameters(connection){
  await tuneSender(connection.videoSender, "video");
  await tuneSender(connection.audioSender, "audio");
}

function setQualityMode(mode){
  if(!QUALITY_PRESETS[mode] || mode === qualityMode){
    return;
  }

  qualityMode = mode;
  storageSet(localStorage, "screenshare-quality", mode);
  renderQualityButtons();

  if(hostStream){
    applyQualityToStream(hostStream);

    for(const connection of hostPeers.values()){
      applySenderParameters(connection);
    }

    showToast(`Modo ${QUALITY_PRESETS[mode].label} activado`);
  }
}

// Opus en estéreo y con más bitrate: el audio de películas suena mucho mejor.
function tuneSdp(sdp){
  const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);

  if(!rtpmap){
    return sdp;
  }

  const payload = rtpmap[1];
  const extra = ["stereo=1", "sprop-stereo=1", `maxaveragebitrate=${AUDIO_MAX_BITRATE}`];
  const fmtp = new RegExp(`a=fmtp:${payload} ([^\\r\\n]*)`);

  if(fmtp.test(sdp)){
    return sdp.replace(fmtp, (line, current)=>{
      const kept = current
        .split(";")
        .map((part)=>part.trim())
        .filter((part)=>part && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(part));

      return `a=fmtp:${payload} ${[...kept, ...extra].join(";")}`;
    });
  }

  return sdp.replace(rtpmap[0], `${rtpmap[0]}\r\na=fmtp:${payload} ${extra.join(";")}`);
}

async function setLocalDescriptionTuned(peer, description){
  try{
    await peer.setLocalDescription({ type:description.type, sdp:tuneSdp(description.sdp) });
  }
  catch(error){
    console.log("SDP ajustado rechazado, usando el original", error);
    await peer.setLocalDescription(description);
  }
}

// Los candidatos ICE pueden llegar antes que la descripción remota: se encolan.
function createCandidateQueue(peer){
  let ready = false;
  const pending = [];

  const apply = (data)=>{
    const { createdAt, ...candidate } = data;
    peer.addIceCandidate(candidate).catch((error)=>{
      console.log("Candidato ICE descartado", error);
    });
  };

  return {
    add(data){
      if(ready){
        apply(data);
      }
      else{
        pending.push(data);
      }
    },
    flush(){
      ready = true;
      pending.splice(0).forEach(apply);
    }
  };
}

/* ---------- Participantes y presencia ---------- */

// La presencia se mide con el reloj local (cuándo vimos cambiar lastSeen),
// así no importa si los relojes de los dispositivos están desfasados.
function trackPresence(participants){
  const now = Date.now();

  for(const participant of participants){
    const previous = participantSeenAt.get(participant.id);

    if(!previous || previous.lastSeen !== participant.lastSeen){
      participantSeenAt.set(participant.id, { lastSeen:participant.lastSeen, seenAt:now });
    }
  }
}

function isParticipantOnline(participant){
  if(participant.status === "left"){
    return false;
  }

  if(hostPeers.get(participant.id)?.peer.connectionState === "connected"){
    return true;
  }

  const seen = participantSeenAt.get(participant.id);
  return Boolean(seen) && Date.now() - seen.seenAt < STALE_AFTER_MS;
}

function isSelf(participant){
  return participant.id === browserSessionId || participant.id === guestParticipantRef?.id;
}

function refreshPresence(){
  const online = participantsCache.filter(isParticipantOnline);

  renderParticipants(online);
  participantCount.textContent = String(online.length);

  if(currentMode === "host"){
    announceNewGuests(online);
    syncHostPeers();
  }
}

function announceNewGuests(online){
  for(const participant of online){
    if(participant.role !== "guest" || announcedGuests.has(participant.id)){
      continue;
    }

    announcedGuests.add(participant.id);

    if(!isCleanMode()){
      showToast(`👋 ${participant.name || "Alguien"} se unió`);
    }
  }
}

function subscribeParticipants(roomId, sessionKey){
  safeCall(participantsUnsub);
  participantsUnsub = null;
  participantsCache = [];
  participantSeenAt.clear();
  refreshPresence();

  if(!sessionKey){
    return;
  }

  const participantsQuery = query(
    collection(db, "rooms", roomId, "participants"),
    where("sessionKey", "==", sessionKey)
  );

  participantsUnsub = onSnapshot(participantsQuery, (snapshot)=>{
    participantsCache = snapshot.docs.map((entry)=>({
      id: entry.id,
      ...entry.data()
    }));

    trackPresence(participantsCache);
    refreshPresence();
  }, (error)=>{
    console.log(error);
  });
}

function renderParticipants(participants){
  participantsList.replaceChildren();

  if(!participants.length){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = roomIsLive || currentMode === "host"
      ? "Todavía no hay participantes"
      : "La sala no está transmitiendo";
    participantsList.appendChild(empty);
    return;
  }

  const ordered = [...participants].sort((a, b)=>{
    if(a.role !== b.role){
      return a.role === "host" ? -1 : 1;
    }

    return (a.joinedAt || 0) - (b.joinedAt || 0);
  });

  for(const participant of ordered){
    const item = document.createElement("div");
    item.className = "participant-item";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = (participant.name || "?").charAt(0).toUpperCase();

    const meta = document.createElement("div");
    meta.className = "participant-meta";

    const title = document.createElement("div");
    title.className = "participant-name";
    title.textContent = `${participant.name || "Sin nombre"}${isSelf(participant) ? " (tú)" : ""}`;

    const subtitle = document.createElement("div");
    subtitle.className = "participant-subtitle";
    subtitle.textContent = participant.role === "host" ? "Anfitrión" : "Invitado";

    meta.append(title, subtitle);

    const connected = participant.role === "host" || participant.status === "connected";
    const badge = document.createElement("span");
    badge.className = `participant-badge ${connected ? "is-active" : "is-pending"}`;
    badge.textContent = connected ? "En sala" : "Conectando…";

    item.append(avatar, meta, badge);
    participantsList.appendChild(item);
  }
}

/* ---------- Chat ---------- */

function subscribeMessages(roomId){
  messagesLoaded = false;

  const messagesQuery = query(
    collection(db, "rooms", roomId, "messages"),
    orderBy("createdAt", "asc"),
    limitToLast(CHAT_HISTORY_LIMIT)
  );

  roomUnsubs.push(onSnapshot(messagesQuery, (snapshot)=>{
    notifyNewMessages(snapshot);
    renderMessages(snapshot.docs.map((entry)=>({
      id: entry.id,
      ...entry.data()
    })));
  }, (error)=>{
    console.log(error);
  }));
}

function notifyNewMessages(snapshot){
  if(!messagesLoaded){
    messagesLoaded = true;
    return;
  }

  for(const change of snapshot.docChanges()){
    const message = change.doc.data();

    if(change.type !== "added" || message.senderId === browserSessionId || isChatVisible()){
      continue;
    }

    unreadCount += 1;

    if(!isCleanMode()){
      showToast(`💬 ${message.senderName || "Anónimo"}: ${message.text || ""}`.slice(0, 140));
    }
  }

  renderUnread();
}

function renderMessages(messages){
  const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;
  chatMessages.replaceChildren();

  if(!messages.length){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Todavía no hay mensajes";
    chatMessages.appendChild(empty);
    return;
  }

  for(const message of messages){
    const row = document.createElement("div");
    row.className = `chat-message ${message.senderId === browserSessionId ? "is-self" : ""}`;

    const meta = document.createElement("div");
    meta.className = "chat-message-meta";

    const author = document.createElement("span");
    author.textContent = message.senderName || "Anónimo";

    const time = document.createElement("span");
    time.className = "chat-message-time";
    time.textContent = formatTime(message.createdAt);

    meta.append(author, time);

    const bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.textContent = message.text || "";

    row.append(meta, bubble);
    chatMessages.appendChild(row);
  }

  if(nearBottom || messages.at(-1)?.senderId === browserSessionId){
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function resetChat(){
  messagesLoaded = false;
  unreadCount = 0;
  renderMessages([]);
  renderUnread();
}

async function sendChatMessage(text){
  const clean = String(text || "").trim();

  if(!currentRoomId || !clean){
    return;
  }

  await addDoc(collection(db, "rooms", currentRoomId, "messages"), {
    senderId: browserSessionId,
    senderName: localDisplayName || getDefaultName(currentMode),
    text: clean,
    createdAt: Date.now()
  });
}

/* ---------- Estadísticas ---------- */

function startStats(){
  if(statsTimer){
    return;
  }

  statsTimer = setInterval(sampleStats, 2000);
  sampleStats();
}

function stopStats(){
  clearInterval(statsTimer);
  statsTimer = null;
  lastStatsSample = null;
  statsChip.hidden = true;
}

function getStatsPeer(){
  if(currentMode === "guest"){
    return guestPeer;
  }

  for(const connection of hostPeers.values()){
    if(connection.peer.connectionState === "connected"){
      return connection.peer;
    }
  }

  return null;
}

async function sampleStats(){
  const peer = getStatsPeer();

  if(!peer || peer.connectionState !== "connected"){
    statsChip.hidden = true;
    lastStatsSample = null;
    return;
  }

  let report;

  try{
    report = await peer.getStats();
  }
  catch{
    return;
  }

  const receiving = currentMode === "guest";
  const rtpType = receiving ? "inbound-rtp" : "outbound-rtp";
  let rtp = null;
  let pair = null;

  report.forEach((stat)=>{
    if(stat.type === rtpType && stat.kind === "video"){
      rtp = stat;
    }

    if(stat.type === "transport" && stat.selectedCandidatePairId){
      pair = report.get(stat.selectedCandidatePairId) || pair;
    }
  });

  if(!pair){
    report.forEach((stat)=>{
      if(!pair && stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded"){
        pair = stat;
      }
    });
  }

  if(!rtp){
    statsChip.hidden = true;
    return;
  }

  const bytes = receiving ? rtp.bytesReceived : rtp.bytesSent;
  const parts = [];

  if(rtp.frameHeight){
    parts.push(`${rtp.frameHeight}p`);
  }

  if(rtp.framesPerSecond){
    parts.push(`${Math.round(rtp.framesPerSecond)} fps`);
  }

  if(lastStatsSample?.peer === peer && lastStatsSample.id === rtp.id){
    const seconds = (rtp.timestamp - lastStatsSample.timestamp) / 1000;

    if(seconds > 0){
      parts.push(formatBitrate((bytes - lastStatsSample.bytes) * 8 / seconds));
    }
  }

  lastStatsSample = { peer, id:rtp.id, bytes, timestamp:rtp.timestamp };

  if(pair){
    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    parts.push(local?.candidateType === "relay" || remote?.candidateType === "relay" ? "TURN" : "Directo");

    if(pair.currentRoundTripTime){
      parts.push(`${Math.round(pair.currentRoundTripTime * 1000)} ms`);
    }
  }

  statsChip.textContent = `${receiving ? "↓" : "↑"} ${parts.join(" · ")}`;
  statsChip.hidden = parts.length === 0;
}

/* ---------- Anfitrión ---------- */

function watchHostStream(stream){
  stream.getVideoTracks()[0]?.addEventListener("ended", ()=>{
    if(hostStream === stream){
      leaveRoom({ reason:"Dejaste de compartir la pantalla" });
    }
  });
}

function stopHostStream(){
  if(!hostStream){
    return;
  }

  hostStream.getTracks().forEach((track)=>track.stop());
  hostStream = null;
  video.srcObject = null;
}

function closeHostPeer(guestId){
  const connection = hostPeers.get(guestId);

  if(!connection){
    return;
  }

  connection.unsubs.forEach(safeCall);
  safeCall(()=>connection.peer.close());
  hostPeers.delete(guestId);
}

function destroyAllHostPeers(){
  for(const guestId of [...hostPeers.keys()]){
    closeHostPeer(guestId);
  }
}

function syncHostPeers(){
  if(!hostStream){
    return;
  }

  const onlineGuests = participantsCache.filter((participant)=>
    participant.role === "guest" && isParticipantOnline(participant)
  );

  for(const guest of onlineGuests){
    if(hostPeers.has(guest.id) || retiredGuests.has(guest.id)){
      continue;
    }

    startHostPeer(currentRoomId, guest).catch((error)=>{
      console.log(error);
      retiredGuests.add(guest.id);
      closeHostPeer(guest.id);
    });
  }

  // Sólo se cierra una conexión cuando el invitado se fue de verdad;
  // un heartbeat atrasado no corta una transmisión que funciona.
  const presentGuestIds = new Set(
    participantsCache
      .filter((participant)=>participant.role === "guest" && participant.status !== "left")
      .map((participant)=>participant.id)
  );

  for(const guestId of [...hostPeers.keys()]){
    if(!presentGuestIds.has(guestId)){
      closeHostPeer(guestId);
    }
  }
}

async function startHostPeer(roomId, guest){
  const guestRef = doc(db, "rooms", roomId, "participants", guest.id);
  const peer = new RTCPeerConnection({ iceServers:ICE_SERVERS });
  const candidates = createCandidateQueue(peer);
  const connection = {
    peer,
    unsubs:[],
    offerNonce: generateId(),
    answered:false,
    videoSender:null,
    audioSender:null
  };

  hostPeers.set(guest.id, connection);

  // Transceptores fijos: permiten cambiar de fuente con replaceTrack,
  // aunque la nueva captura tenga o no audio.
  const videoTrack = hostStream.getVideoTracks()[0];
  const audioTrack = hostStream.getAudioTracks()[0] || null;
  connection.videoSender = peer.addTransceiver(videoTrack, { direction:"sendonly" }).sender;
  connection.audioSender = peer.addTransceiver(audioTrack || "audio", { direction:"sendonly" }).sender;

  peer.onicecandidate = (event)=>{
    if(!event.candidate){
      return;
    }

    addDoc(collection(guestRef, "hostCandidates"), {
      ...event.candidate.toJSON(),
      createdAt: Date.now()
    }).catch((error)=>console.log(error));
  };

  peer.onconnectionstatechange = ()=>{
    if(hostPeers.get(guest.id) !== connection){
      return;
    }

    if(peer.connectionState === "connected"){
      applySenderParameters(connection);
      refreshPresence();
    }

    if(peer.connectionState === "failed"){
      retiredGuests.add(guest.id);
      closeHostPeer(guest.id);
      refreshPresence();
    }
  };

  connection.unsubs.push(onSnapshot(collection(guestRef, "guestCandidates"), (snapshot)=>{
    snapshot.docChanges().forEach((change)=>{
      if(change.type === "added"){
        candidates.add(change.doc.data());
      }
    });
  }));

  connection.unsubs.push(onSnapshot(guestRef, async(snapshot)=>{
    const data = snapshot.data();

    if(!data || hostPeers.get(guest.id) !== connection){
      return;
    }

    if(data.status === "left"){
      closeHostPeer(guest.id);
      return;
    }

    if(connection.answered || !data.answer?.sdp || data.answer.nonce !== connection.offerNonce){
      return;
    }

    connection.answered = true;

    try{
      await peer.setRemoteDescription({ type:"answer", sdp:data.answer.sdp });
      candidates.flush();
    }
    catch(error){
      console.log(error);
    }
  }));

  const offer = await peer.createOffer();
  await setLocalDescriptionTuned(peer, offer);

  await updateDoc(guestRef, {
    offer:{
      type:"offer",
      sdp: peer.localDescription.sdp,
      nonce: connection.offerNonce
    }
  });
}

async function startHosting(){
  if(busy || !canCaptureScreen()){
    return;
  }

  const name = saveName(nameInput.value) || getDefaultName("host");
  const roomId = normalizeRoomId(roomInput.value) || generateRoomId();
  let stream;

  setBusy(true);

  try{
    // La captura va primero: el navegador exige que ocurra justo tras el clic.
    stream = await captureScreen();
  }
  catch(error){
    setBusy(false);

    if(!isUserCancel(error)){
      console.log(error);
    }

    setRoomStatus(isUserCancel(error) ? "Captura cancelada" : "No se pudo iniciar la captura");
    return;
  }

  try{
    const roomRef = doc(db, "rooms", roomId);
    const snapshot = await getDoc(roomRef);
    const existing = snapshot.exists() ? snapshot.data() : null;

    if(existing?.active && existing.hostSessionId !== browserSessionId){
      const takeOver = confirm(
        `La sala ${roomId} ya está transmitiendo (${existing.hostName || "otro anfitrión"}). ¿Quieres tomar el control?`
      );

      if(!takeOver){
        stream.getTracks().forEach((track)=>track.stop());
        setRoomStatus("Elige otro código de sala");
        return;
      }
    }

    await leaveRoom({ quiet:true });

    hostStream = stream;
    hostSessionKey = generateId();
    currentRoomId = roomId;
    applyQualityToStream(stream);
    watchHostStream(stream);
    setMode("host");
    showLocalPreview();

    await setDoc(roomRef, {
      active:true,
      createdAt: existing?.createdAt || Date.now(),
      startedAt: Date.now(),
      hostName: name,
      hostSessionId: browserSessionId,
      sessionKey: hostSessionKey
    }, { merge:true });

    hostParticipantRef = doc(db, "rooms", roomId, "participants", browserSessionId);

    await setDoc(hostParticipantRef, {
      participantId: browserSessionId,
      name,
      role:"host",
      status:"connected",
      sessionKey: hostSessionKey,
      joinedAt: Date.now(),
      lastSeen: Date.now()
    });

    subscribeParticipants(roomId, hostSessionKey);
    subscribeMessages(roomId);
    enterRoomUi(roomId);
    setLive("live", "En vivo");
    setStage(null);
    setRoomStatus(`Transmitiendo como ${name}`);
    startHeartbeat();
    startStats();
    requestWakeLock();
  }
  catch(error){
    console.log(error);
    stream.getTracks().forEach((track)=>track.stop());
    await leaveRoom({ reason:"No se pudo crear la sala" });
  }
  finally{
    setBusy(false);
  }
}

async function switchSource(){
  if(currentMode !== "host" || !hostStream){
    return;
  }

  let stream;

  try{
    stream = await captureScreen();
  }
  catch(error){
    if(!isUserCancel(error)){
      console.log(error);
      showToast("No se pudo cambiar la fuente");
    }

    return;
  }

  if(currentMode !== "host"){
    stream.getTracks().forEach((track)=>track.stop());
    return;
  }

  const previous = hostStream;
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0] || null;

  hostStream = stream;
  applyQualityToStream(stream);
  watchHostStream(stream);

  await Promise.all([...hostPeers.values()].map(async(connection)=>{
    try{
      await connection.videoSender?.replaceTrack(videoTrack);
      await connection.audioSender?.replaceTrack(audioTrack);
      await applySenderParameters(connection);
    }
    catch(error){
      console.log(error);
    }
  }));

  previous.getTracks().forEach((track)=>track.stop());
  showLocalPreview();
  showToast(audioTrack ? "Fuente cambiada" : "Fuente cambiada (sin audio)");
}

/* ---------- Invitado ---------- */

function clearGuestTimers(){
  clearTimeout(guestRetryTimer);
  clearTimeout(guestWatchdogTimer);
  clearTimeout(guestDisconnectTimer);
}

function teardownGuestConnection(markLeft){
  clearGuestTimers();
  guestUnsubs.forEach(safeCall);
  guestUnsubs = [];

  if(markLeft && guestParticipantRef){
    updateDoc(guestParticipantRef, {
      status:"left",
      leftAt: Date.now()
    }).catch(()=>{});
  }

  safeCall(()=>guestPeer?.close());
  guestPeer = null;
  guestParticipantRef = null;
  guestOfferNonce = "";

  if(remoteStream){
    remoteStream = null;
    video.srcObject = null;
  }

  unmuteBtn.hidden = true;

  if(currentMode === "guest"){
    stopStats();
  }
}

function scheduleGuestReconnect(delay = 2000){
  if(currentMode !== "guest" || !roomIsLive){
    return;
  }

  clearGuestTimers();
  setLive("wait", "Reconectando");
  setStage("reconnecting", guestAttempts >= 3 ? TURN_HINT : "");
  setRoomStatus(`Reconectando a la sala ${currentRoomId}…`);

  guestRetryTimer = setTimeout(()=>{
    connectGuest().catch((error)=>{
      console.log(error);
      scheduleGuestReconnect(4000);
    });
  }, delay);
}

function handleGuestConnectionState(peer){
  if(peer !== guestPeer){
    return;
  }

  clearTimeout(guestDisconnectTimer);

  switch(peer.connectionState){
    case "connected":
      clearTimeout(guestWatchdogTimer);
      guestAttempts = 0;
      setLive("live", "En vivo");
      setStage(null);
      setRoomStatus(`Viendo a ${currentHostName || "el anfitrión"}`);
      startStats();
      break;

    case "disconnected":
      setLive("wait", "Señal inestable");
      guestDisconnectTimer = setTimeout(()=>{
        if(guestPeer === peer && peer.connectionState !== "connected"){
          scheduleGuestReconnect(0);
        }
      }, GUEST_DISCONNECT_GRACE_MS);
      break;

    case "failed":
      scheduleGuestReconnect();
      break;
  }
}

async function connectGuest(){
  teardownGuestConnection(true);

  if(currentMode !== "guest" || !roomIsLive){
    return;
  }

  const roomId = currentRoomId;
  const sessionKey = guestSessionKey;
  const participantRef = doc(collection(db, "rooms", roomId, "participants"));
  const peer = new RTCPeerConnection({ iceServers:ICE_SERVERS });
  const candidates = createCandidateQueue(peer);

  guestAttempts += 1;
  guestPeer = peer;
  guestParticipantRef = participantRef;
  remoteStream = new MediaStream();

  if(guestAttempts === 1){
    setLive("wait", "Conectando");
    setStage("connecting");
  }

  peer.ontrack = (event)=>{
    if(guestPeer !== peer){
      return;
    }

    remoteStream.addTrack(event.track);
    attachRemoteStream();
  };

  peer.onicecandidate = (event)=>{
    if(!event.candidate || guestPeer !== peer){
      return;
    }

    addDoc(collection(participantRef, "guestCandidates"), {
      ...event.candidate.toJSON(),
      createdAt: Date.now()
    }).catch((error)=>console.log(error));
  };

  peer.onconnectionstatechange = ()=>handleGuestConnectionState(peer);

  guestWatchdogTimer = setTimeout(()=>{
    if(guestPeer === peer && peer.connectionState !== "connected"){
      scheduleGuestReconnect(0);
    }
  }, GUEST_CONNECT_TIMEOUT_MS);

  await setDoc(participantRef, {
    participantId: participantRef.id,
    name: localDisplayName || getDefaultName("guest"),
    role:"guest",
    status:"joining",
    sessionKey,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  });

  if(guestPeer !== peer){
    return;
  }

  guestUnsubs.push(onSnapshot(collection(participantRef, "hostCandidates"), (snapshot)=>{
    snapshot.docChanges().forEach((change)=>{
      if(change.type === "added"){
        candidates.add(change.doc.data());
      }
    });
  }));

  guestUnsubs.push(onSnapshot(participantRef, async(snapshot)=>{
    const data = snapshot.data();

    if(guestPeer !== peer || !data?.offer?.sdp || peer.remoteDescription || data.offer.nonce === guestOfferNonce){
      return;
    }

    guestOfferNonce = data.offer.nonce || "";

    try{
      await peer.setRemoteDescription({ type:"offer", sdp:data.offer.sdp });
      candidates.flush();

      const answer = await peer.createAnswer();
      await setLocalDescriptionTuned(peer, answer);

      await updateDoc(participantRef, {
        answer:{
          type:"answer",
          sdp: peer.localDescription.sdp,
          nonce: data.offer.nonce
        },
        status:"connected",
        lastSeen: Date.now()
      });
    }
    catch(error){
      console.log(error);
      scheduleGuestReconnect();
    }
  }));
}

// El documento de la sala dice si hay transmisión y cuál es la sesión actual.
// Si el anfitrión vuelve a transmitir en la misma sala, el invitado se reconecta solo.
function subscribeRoomState(roomId){
  roomUnsubs.push(onSnapshot(doc(db, "rooms", roomId), (snapshot)=>{
    const room = snapshot.data();

    if(!room?.active){
      const wasLive = roomIsLive;
      roomIsLive = false;
      guestSessionKey = "";
      teardownGuestConnection(true);
      subscribeParticipants(roomId, "");
      setLive("off", "Sin señal");
      setStage(wasLive ? "ended" : "waiting");
      setRoomStatus(wasLive ? "La transmisión terminó" : `Esperando en la sala ${roomId}`);
      return;
    }

    roomIsLive = true;
    currentHostName = room.hostName || "";

    if(room.sessionKey !== guestSessionKey){
      guestSessionKey = room.sessionKey || "";
      guestAttempts = 0;
      subscribeParticipants(roomId, guestSessionKey);
      connectGuest().catch((error)=>{
        console.log(error);
        scheduleGuestReconnect(4000);
      });
    }
  }, (error)=>{
    console.log(error);
    setRoomStatus("No se pudo leer la sala");
  }));
}

async function joinRoom(){
  if(busy){
    return;
  }

  const roomId = normalizeRoomId(roomInput.value);

  if(!roomId){
    setRoomStatus("Escribe un código de sala");
    roomInput.focus();
    return;
  }

  saveName(nameInput.value);
  setBusy(true);

  try{
    const snapshot = await getDoc(doc(db, "rooms", roomId));

    if(!snapshot.exists() && !autoJoin){
      setRoomStatus(`La sala ${roomId} no existe`);
      showToast("Revisa el código de la sala");
      return;
    }

    await leaveRoom({ quiet:true });

    currentRoomId = roomId;
    setMode("guest");
    enterRoomUi(roomId);
    setLive("wait", "Esperando");
    setStage("waiting");
    setRoomStatus(`Esperando en la sala ${roomId}`);
    subscribeMessages(roomId);
    subscribeRoomState(roomId);
    startHeartbeat();
    requestWakeLock();
  }
  catch(error){
    console.log(error);
    setRoomStatus("No se pudo entrar a la sala");
  }
  finally{
    setBusy(false);
  }
}

/* ---------- Ciclo de vida ---------- */

function startHeartbeat(){
  stopHeartbeat();

  heartbeatTimer = setInterval(()=>{
    const ref = currentMode === "host" ? hostParticipantRef : guestParticipantRef;

    if(ref){
      updateDoc(ref, { lastSeen: Date.now() }).catch(()=>{});
    }

    refreshPresence();
  }, HEARTBEAT_MS);
}

function stopHeartbeat(){
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function clearRoomSubscriptions(){
  roomUnsubs.forEach(safeCall);
  roomUnsubs = [];
  safeCall(participantsUnsub);
  participantsUnsub = null;
}

function markHostRoomEnded(roomId){
  if(!roomId){
    return;
  }

  updateDoc(doc(db, "rooms", roomId), {
    active:false,
    endedAt: Date.now()
  }).catch(()=>{});

  if(hostParticipantRef){
    updateDoc(hostParticipantRef, {
      status:"left",
      leftAt: Date.now()
    }).catch(()=>{});
  }
}

async function leaveRoom({ quiet = false, reason = "" } = {}){
  const wasHost = currentMode === "host";
  const roomId = currentRoomId;

  clearRoomSubscriptions();
  teardownGuestConnection(true);
  destroyAllHostPeers();
  stopHostStream();
  stopHeartbeat();
  stopStats();

  if(wasHost){
    markHostRoomEnded(roomId);
  }

  hostParticipantRef = null;
  hostSessionKey = "";
  guestSessionKey = "";
  guestAttempts = 0;
  roomIsLive = false;
  currentRoomId = "";
  currentHostName = "";
  participantsCache = [];
  participantSeenAt.clear();
  retiredGuests.clear();
  announcedGuests.clear();

  if(quiet){
    return;
  }

  releaseWakeLock();
  setCleanMode(false);

  if(document.fullscreenElement){
    document.exitFullscreen().catch(()=>{});
  }

  setMode("idle");
  setLive("off", "Sin señal");
  setStage("idle");
  participantCount.textContent = "0";
  resetChat();
  updateUrl("");
  updateLobbyButtons();
  document.title = "ScreenShare";
  setRoomStatus(reason || "Listo");

  if(reason){
    showToast(reason);
  }
}

/* ---------- Eventos ---------- */

hostBtn.addEventListener("click", startHosting);
joinBtn.addEventListener("click", joinRoom);
switchSourceBtn.addEventListener("click", switchSource);

leaveBtn.addEventListener("click", ()=>{
  leaveRoom({ reason: currentMode === "host" ? "Transmisión terminada" : "Saliste de la sala" });
});

roomInput.addEventListener("input", updateLobbyButtons);

roomInput.addEventListener("change", ()=>{
  roomInput.value = normalizeRoomId(roomInput.value);
  updateLobbyButtons();
});

roomInput.addEventListener("paste", ()=>{
  setTimeout(()=>{
    roomInput.value = normalizeRoomId(roomInput.value);
    updateLobbyButtons();
  });
});

roomInput.addEventListener("keydown", (event)=>{
  if(event.key === "Enter"){
    event.preventDefault();
    joinRoom();
  }
});

nameInput.addEventListener("change", ()=>{
  saveName(nameInput.value);
});

nameInput.addEventListener("keydown", (event)=>{
  if(event.key === "Enter"){
    event.preventDefault();

    if(normalizeRoomId(roomInput.value)){
      joinRoom();
    }
    else{
      roomInput.focus();
    }
  }
});

qualityButtons.forEach((button)=>{
  button.addEventListener("click", ()=>setQualityMode(button.dataset.quality));
});

tabButtons.forEach((button)=>{
  button.addEventListener("click", ()=>setTab(button.dataset.tab));
});

copyBtn.addEventListener("click", async()=>{
  const original = "🔗 Copiar";

  try{
    await navigator.clipboard.writeText(roomLink.value);
  }
  catch{
    roomLink.select();
    document.execCommand("copy");
  }

  copyBtn.textContent = "Copiado ✓";
  setTimeout(()=>{
    copyBtn.textContent = original;
  }, 1500);
});

shareBtn.addEventListener("click", ()=>{
  navigator.share({
    title:"ScreenShare",
    text:`Únete a la sala ${currentRoomId}`,
    url: roomLink.value
  }).catch(()=>{});
});

chatForm.addEventListener("submit", async(event)=>{
  event.preventDefault();

  const text = chatInput.value;
  chatInput.value = "";

  try{
    await sendChatMessage(text);
  }
  catch(error){
    console.log(error);
    chatInput.value = text;
    showToast("No se pudo enviar el mensaje");
  }
});

unmuteBtn.addEventListener("click", ()=>setMuted(false));
muteBtn.addEventListener("click", ()=>setMuted(!(video.muted || video.volume === 0)));

volumeRange.addEventListener("input", ()=>{
  const volume = Number(volumeRange.value);
  video.volume = volume;

  if(volume > 0){
    preferVolume = volume;
    storageSet(localStorage, "screenshare-volume", String(volume));
  }

  setMuted(volume === 0);
});

pipBtn.addEventListener("click", togglePictureInPicture);
cleanBtn.addEventListener("click", ()=>setCleanMode(!isCleanMode()));
fullscreenBtn.addEventListener("click", toggleFullscreen);
video.addEventListener("dblclick", toggleFullscreen);
stage.addEventListener("pointermove", pokeStageUi);
stage.addEventListener("pointerdown", pokeStageUi);

document.addEventListener("keydown", (event)=>{
  if(currentMode === "idle" || event.ctrlKey || event.metaKey || event.altKey){
    return;
  }

  if(event.target.closest?.("input, textarea")){
    return;
  }

  switch(event.key.toLowerCase()){
    case "f":
      toggleFullscreen();
      break;
    case "c":
      setCleanMode(!isCleanMode());
      break;
    case "m":
      if(currentMode === "guest"){
        setMuted(!video.muted);
      }
      break;
    case "escape":
      if(!isCleanMode()){
        return;
      }
      setCleanMode(false);
      break;
    default:
      return;
  }

  event.preventDefault();
});

document.addEventListener("visibilitychange", ()=>{
  if(document.visibilityState === "visible" && currentMode !== "idle"){
    requestWakeLock();
  }
});

window.addEventListener("pagehide", ()=>{
  if(guestParticipantRef){
    updateDoc(guestParticipantRef, {
      status:"left",
      leftAt: Date.now()
    }).catch(()=>{});
  }

  if(currentMode === "host"){
    markHostRoomEnded(currentRoomId);
  }

  hostStream?.getTracks().forEach((track)=>track.stop());
  safeCall(()=>guestPeer?.close());
  destroyAllHostPeers();
});

/* ---------- Inicio ---------- */

nameInput.value = localDisplayName;
roomInput.value = roomFromUrl;
video.volume = preferVolume;
pipBtn.hidden = !document.pictureInPictureEnabled;
shareBtn.hidden = !navigator.share;

setMode("idle");
setLive("off", "Sin señal");
setStage("idle");
renderQualityButtons();
renderAudioControls();
updateLobbyButtons();
setBusy(false);

if(!canCaptureScreen()){
  hostBtn.title = "Este navegador no permite compartir pantalla";
  lobbyHint.textContent = "Este dispositivo solo puede ver transmisiones: compartir pantalla requiere un navegador de escritorio.";
}

setRoomStatus(roomFromUrl ? `Sala detectada: ${roomFromUrl}` : "Listo");

if(roomFromUrl && autoJoin){
  joinRoom();
}
