import { db } from "./firebase.js";

import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  collection,
  addDoc,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const video = document.getElementById("video");
const hostBtn = document.getElementById("host");
const joinBtn = document.getElementById("join");
const roomInput = document.getElementById("roomInput");
const nameInput = document.getElementById("nameInput");
const roomLink = document.getElementById("roomLink");
const shareBox = document.getElementById("shareBox");
const copyBtn = document.getElementById("copyBtn");
const sidebar = document.getElementById("sidebar");
const roomStatus = document.getElementById("roomStatus");
const participantsList = document.getElementById("participantsList");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

const browserSessionId = getStoredSessionId();
const roomFromUrl = new URLSearchParams(window.location.search).get("room");

let currentRoomId = "";
let currentMode = "idle";
let hostStream = null;
let hostParticipantRef = null;
let guestParticipantRef = null;
let guestPeer = null;
let guestOfferNonce = "";
let roomUnsubs = [];
let hostPeers = new Map();
let localDisplayName = getStoredName();
let heartbeatTimer = null;

roomInput.value = roomFromUrl || "";
nameInput.value = localDisplayName || "";
setRoomStatus("Listo");
setSidebarVisible(false);

function getStoredSessionId(){
  const key = "screenshare-session-id";
  const stored = sessionStorage.getItem(key);

  if(stored){
    return stored;
  }

  const fresh = crypto.randomUUID();
  sessionStorage.setItem(key, fresh);
  return fresh;
}

function getStoredName(){
  return sessionStorage.getItem("screenshare-name") || "";
}

function saveName(name){
  const clean = normalizeName(name);

  if(clean){
    sessionStorage.setItem("screenshare-name", clean);
  }

  localDisplayName = clean;
  nameInput.value = clean;
  return clean;
}

function normalizeName(name){
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

function getDisplayName(){
  const typed = normalizeName(nameInput.value);

  if(typed){
    return typed;
  }

  if(localDisplayName){
    return localDisplayName;
  }

  return currentMode === "host"
    ? "Host"
    : `Guest-${browserSessionId.slice(0, 4).toUpperCase()}`;
}

function generateRoomId(){
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateId(){
  return crypto.randomUUID();
}

function setRoomStatus(message){
  roomStatus.textContent = message;
}

function setSidebarVisible(visible){
  sidebar.style.display = visible ? "grid" : "none";
}

function setShareLink(roomId){
  roomLink.value = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
  shareBox.style.display = "flex";
}

function clearRoomSubscriptions(){
  for(const unsubscribe of roomUnsubs){
    try{
      unsubscribe();
    }
    catch{}
  }

  roomUnsubs = [];
}

function trackRoomSubscription(unsubscribe){
  roomUnsubs.push(unsubscribe);
  return unsubscribe;
}

function destroyGuestPeer(){
  try{
    guestPeer?.close();
  }
  catch{}

  guestPeer = null;
  guestParticipantRef = null;
  guestOfferNonce = "";
}

function destroyAllHostPeers(){
  for(const [guestId, connection] of hostPeers.entries()){
    try{
      connection.unsubscribeDoc?.();
      connection.unsubscribeHostCandidates?.();
      connection.peer?.close();
    }
    catch{}

    hostPeers.delete(guestId);
  }
}

function stopHostStream(){
  if(!hostStream){
    return;
  }

  hostStream.getTracks().forEach((track)=>track.stop());
  hostStream = null;
  video.srcObject = null;
}

function setRemoteVideo(stream){
  video.pause();
  video.srcObject = null;

  requestAnimationFrame(()=>{
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;
    video.volume = 1;
    video.play().catch(()=>{});
  });
}

async function getDisplayStream(){
  const high = {
    video:{
      width:{ideal:1920,max:1920},
      height:{ideal:1080,max:1080},
      frameRate:{ideal:60,max:60}
    },
    audio:true
  };

  const fallback = {
    video:{
      width:{ideal:1280,max:1280},
      height:{ideal:720,max:720},
      frameRate:{ideal:60,max:60}
    },
    audio:true
  };

  try{
    return await navigator.mediaDevices.getDisplayMedia(high);
  }
  catch(error){
    console.log("No se pudo pedir 1080p, usando 720p", error);
    return await navigator.mediaDevices.getDisplayMedia(fallback);
  }
}

function prepareScreenTracks(stream){
  const videoTrack = stream.getVideoTracks()[0];

  if(videoTrack){
    videoTrack.contentHint = "detail";

    try{
      videoTrack.applyConstraints({
        width:{ideal:1920,max:1920},
        height:{ideal:1080,max:1080},
        frameRate:{ideal:60,max:60}
      }).catch(()=>{});
    }
    catch{}
  }

  return stream;
}

function configureVideoSender(sender){
  if(sender.track?.kind !== "video"){
    return;
  }

  try{
    const parameters = sender.getParameters();
    parameters.degradationPreference = "maintain-resolution";
    parameters.encodings = [
      {
        scaleResolutionDownBy:1,
        maxBitrate:12000000,
        maxFramerate:60
      }
    ];

    sender.setParameters(parameters).catch((error)=>{
      console.log("No se pudieron fijar los parámetros de envío", error);
    });
  }
  catch(error){
    console.log("No se pudieron fijar los parámetros de envío", error);
  }
}

function renderParticipants(participants){
  participantsList.innerHTML = "";

  if(!participants.length){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Todavía no hay participantes";
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

    const meta = document.createElement("div");
    meta.className = "participant-meta";

    const title = document.createElement("div");
    title.className = "participant-name";
    title.textContent = participant.name || "Sin nombre";

    const subtitle = document.createElement("div");
    subtitle.className = "participant-subtitle";
    subtitle.textContent = participant.role === "host" ? "Host" : "Invitado";

    meta.append(title, subtitle);

    const badge = document.createElement("span");
    badge.className = `participant-badge ${participant.status === "left" ? "is-left" : "is-active"}`;
    badge.textContent = participant.status === "left" ? "Fuera" : "En sala";

    item.append(meta, badge);
    participantsList.appendChild(item);
  }
}

function renderMessages(messages){
  chatMessages.innerHTML = "";

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
    meta.textContent = message.senderName || "Anónimo";

    const bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    bubble.textContent = message.text || "";

    row.append(meta, bubble);
    chatMessages.appendChild(row);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function subscribeParticipants(roomId){
  const participantsQuery = query(
    collection(db, "rooms", roomId, "participants"),
    orderBy("joinedAt", "asc")
  );

  const unsubscribe = onSnapshot(participantsQuery, (snapshot)=>{
    const participants = snapshot.docs.map((entry)=>({
      id: entry.id,
      ...entry.data()
    }));

    renderParticipants(participants);

    if(currentMode === "host"){
      syncHostPeers(roomId, participants);
    }
  });

  trackRoomSubscription(unsubscribe);
}

function subscribeMessages(roomId){
  const messagesQuery = query(
    collection(db, "rooms", roomId, "messages"),
    orderBy("createdAt", "asc")
  );

  const unsubscribe = onSnapshot(messagesQuery, (snapshot)=>{
    const messages = snapshot.docs.map((entry)=>({
      id: entry.id,
      ...entry.data()
    }));

    renderMessages(messages);
  });

  trackRoomSubscription(unsubscribe);
}

function syncHostPeers(roomId, participants){
  const activeGuestIds = new Set(
    participants
      .filter((participant)=>participant.role === "guest" && participant.status !== "left")
      .map((participant)=>participant.id)
  );

  for(const guest of participants){
    if(guest.role !== "guest" || guest.status === "left"){
      continue;
    }

    if(!hostPeers.has(guest.id)){
      startHostPeer(roomId, guest).catch((error)=>{
        console.log(error);
      });
    }
  }

  for(const [guestId] of hostPeers.entries()){
    if(activeGuestIds.has(guestId)){
      continue;
    }

    closeHostPeer(guestId);
  }
}

function closeHostPeer(guestId){
  const connection = hostPeers.get(guestId);

  if(!connection){
    return;
  }

  try{
    connection.unsubscribeDoc?.();
    connection.unsubscribeHostCandidates?.();
    connection.peer?.close();
  }
  catch{}

  hostPeers.delete(guestId);
}

async function startHostPeer(roomId, guest){
  if(!hostStream){
    return;
  }

  const guestRef = doc(db, "rooms", roomId, "participants", guest.id);
  const hostCandidatesRef = collection(guestRef, "hostCandidates");
  const guestCandidatesRef = collection(guestRef, "guestCandidates");
  const peer = new RTCPeerConnection({
    iceServers:[{urls:"stun:stun.l.google.com:19302"}]
  });

  const connection = {
    peer,
    unsubscribeDoc:null,
    unsubscribeHostCandidates:null,
    offerNonce: generateId(),
    answerSdp: ""
  };

  hostPeers.set(guest.id, connection);

  for(const track of hostStream.getTracks()){
    const sender = peer.addTrack(track, hostStream);
    configureVideoSender(sender);
  }

  peer.onicecandidate = async(event)=>{
    if(!event.candidate){
      return;
    }

    await addDoc(hostCandidatesRef, {
      ...event.candidate.toJSON(),
      createdAt: Date.now()
    });
  };

  peer.onconnectionstatechange = ()=>{
    if(peer.connectionState === "failed" || peer.connectionState === "closed"){
      closeHostPeer(guest.id);
    }
  };

  connection.unsubscribeHostCandidates = onSnapshot(guestCandidatesRef, (snapshot)=>{
    snapshot.docChanges().forEach(async(change)=>{
      if(change.type !== "added"){
        return;
      }

      try{
        await peer.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
      catch(error){
        console.log(error);
      }
    });
  });

  connection.unsubscribeDoc = onSnapshot(guestRef, async(snapshot)=>{
    const data = snapshot.data();

    if(!data){
      return;
    }

    if(data.status === "left"){
      closeHostPeer(guest.id);
      return;
    }

    if(data.answer?.sdp && data.answer.sdp !== connection.answerSdp){
      try{
        connection.answerSdp = data.answer.sdp;

        if(!peer.remoteDescription){
          await peer.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
      }
      catch(error){
        console.log(error);
      }
    }
  });

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  await setDoc(guestRef, {
    name: guest.name,
    role: "guest",
    status: "offered",
    joinedAt: guest.joinedAt || Date.now(),
    offer:{
      type: offer.type,
      sdp: offer.sdp,
      nonce: connection.offerNonce
    }
  }, { merge:true });

}

async function startHostRoom(roomId){
  clearRoomSubscriptions();
  destroyGuestPeer();
  destroyAllHostPeers();
  stopHostStream();

  currentMode = "host";
  currentRoomId = roomId;
  setSidebarVisible(true);
  hostBtn.style.display = "inline-flex";
  shareBox.style.display = "flex";

  const roomName = getDisplayName() || "Host";
  saveName(roomName);

  hostStream = prepareScreenTracks(await getDisplayStream());
  video.srcObject = hostStream;
  video.muted = true;
  video.volume = 0;

  const roomRef = doc(db, "rooms", roomId);
  await setDoc(roomRef, {
    active:true,
    createdAt: Date.now(),
    hostName: roomName,
    hostSessionId: browserSessionId
  });

  hostParticipantRef = doc(db, "rooms", roomId, "participants", browserSessionId);
  await setDoc(hostParticipantRef, {
    participantId: browserSessionId,
    name: roomName,
    role: "host",
    status: "connected",
    joinedAt: Date.now(),
    lastSeen: Date.now()
  });

  subscribeParticipants(roomId);
  subscribeMessages(roomId);

  roomStatus.textContent = `Sala activa como ${roomName}`;
  setShareLink(roomId);
  roomInput.value = roomId;
}

async function startGuestRoom(roomId, guestName){
  clearRoomSubscriptions();
  destroyGuestPeer();
  destroyAllHostPeers();
  stopHostStream();

  const roomRef = doc(db, "rooms", roomId);
  const roomSnap = await getDoc(roomRef);

  if(!roomSnap.exists()){
    setRoomStatus("La sala no existe o todavía no fue creada.");
    return;
  }

  currentMode = "guest";
  currentRoomId = roomId;
  setSidebarVisible(true);
  hostBtn.style.display = "none";
  shareBox.style.display = "none";
  saveName(guestName);

  guestParticipantRef = doc(db, "rooms", roomId, "participants", generateId());
  guestOfferNonce = "";

  await setDoc(guestParticipantRef, {
    participantId: guestParticipantRef.id,
    name: guestName,
    role: "guest",
    status: "joining",
    joinedAt: Date.now(),
    lastSeen: Date.now()
  });

  guestPeer = new RTCPeerConnection({
    iceServers:[{urls:"stun:stun.l.google.com:19302"}]
  });

  guestPeer.ontrack = async(event)=>{
    const stream = event.streams[0];

    if(!stream){
      return;
    }

    setRemoteVideo(stream);
  };

  guestPeer.onicecandidate = async(event)=>{
    if(!event.candidate || !guestParticipantRef){
      return;
    }

    await addDoc(collection(guestParticipantRef, "guestCandidates"), {
      ...event.candidate.toJSON(),
      createdAt: Date.now()
    });
  };

  trackRoomSubscription(onSnapshot(
    collection(guestParticipantRef, "hostCandidates"),
    (snapshot)=>{
      snapshot.docChanges().forEach(async(change)=>{
        if(change.type !== "added"){
          return;
        }

        try{
          await guestPeer.addIceCandidate(new RTCIceCandidate(change.doc.data()));
        }
        catch(error){
          console.log(error);
        }
      });
    }
  ));

  trackRoomSubscription(onSnapshot(
    guestParticipantRef,
    async(snapshot)=>{
      const data = snapshot.data();

      if(!data?.offer?.sdp){
        return;
      }

      if(data.offer.nonce === guestOfferNonce){
        return;
      }

      try{
        guestOfferNonce = data.offer.nonce || "";
        await guestPeer.setRemoteDescription(new RTCSessionDescription(data.offer));

        const answer = await guestPeer.createAnswer();
        await guestPeer.setLocalDescription(answer);

        await updateDoc(guestParticipantRef, {
          answer:{
            type: answer.type,
            sdp: answer.sdp
          },
          status: "connected",
          lastSeen: Date.now()
        });

        roomStatus.textContent = `Conectado como ${guestName}`;
      }
      catch(error){
        console.log(error);
      }
    }
  ));

  subscribeParticipants(roomId);
  subscribeMessages(roomId);

  roomStatus.textContent = `Unido a la sala ${roomId}`;
  roomInput.value = roomId;
}

function joinRoomFromInputs(){
  const roomId = normalizeRoomId(roomInput.value);
  const guestName = getDisplayName() || `Guest-${browserSessionId.slice(0, 4).toUpperCase()}`;

  if(!roomId){
    setRoomStatus("Escribe un código de sala");
    return Promise.resolve();
  }

  return startGuestRoom(roomId, guestName);
}

function normalizeRoomId(value){
  return String(value || "").trim().toUpperCase();
}

function clearChatInput(){
  chatInput.value = "";
}

async function sendChatMessage(text){
  if(!currentRoomId){
    return;
  }

  const clean = String(text || "").trim();

  if(!clean){
    return;
  }

  await addDoc(collection(db, "rooms", currentRoomId, "messages"), {
    senderId: browserSessionId,
    senderName: getDisplayName(),
    text: clean,
    createdAt: Date.now()
  });
}

function setRoomStatusToReadyForJoin(){
  if(roomFromUrl){
    roomStatus.textContent = `Sala detectada: ${normalizeRoomId(roomFromUrl)}`;
  }
  else{
    roomStatus.textContent = "Listo";
  }
}

function startHeartbeat(){
  clearInterval(heartbeatTimer);

  heartbeatTimer = setInterval(()=>{
    if(!currentRoomId || currentMode === "idle"){
      return;
    }

    const ref = currentMode === "host" ? hostParticipantRef : guestParticipantRef;

    if(!ref){
      return;
    }

    updateDoc(ref, {
      lastSeen: Date.now(),
      status: currentMode === "guest" ? "connected" : "connected"
    }).catch(()=>{});
  }, 15000);
}

hostBtn.onclick = async()=>{
  try{
    const roomId = generateRoomId();
    currentMode = "host";
    localDisplayName = saveName(nameInput.value || localDisplayName || "Host");
    await startHostRoom(roomId);
    startHeartbeat();
  }
  catch(error){
    console.log(error);
    setRoomStatus("No se pudo iniciar la captura");
  }
};

joinBtn.onclick = async()=>{
  saveName(nameInput.value);
  await joinRoomFromInputs();
  startHeartbeat();
};

nameInput.addEventListener("change", ()=>{
  saveName(nameInput.value);
});

roomInput.addEventListener("keydown", async(event)=>{
  if(event.key === "Enter"){
    event.preventDefault();
    await joinRoomFromInputs();
  }
});

nameInput.addEventListener("keydown", async(event)=>{
  if(event.key === "Enter"){
    event.preventDefault();

    if(currentMode === "host"){
      return;
    }

    await joinRoomFromInputs();
  }
});

copyBtn.onclick = async()=>{
  try{
    await navigator.clipboard.writeText(roomLink.value);
    copyBtn.innerText = "Copiado ✓";

    setTimeout(()=>{
      copyBtn.innerText = "Copiar enlace";
    }, 1500);
  }
  catch(error){
    console.log(error);
  }
};

chatForm.addEventListener("submit", async(event)=>{
  event.preventDefault();

  try{
    await sendChatMessage(chatInput.value);
    clearChatInput();
  }
  catch(error){
    console.log(error);
  }
});

window.addEventListener("beforeunload", ()=>{
  const updates = [];

  if(guestParticipantRef){
    updates.push(
      updateDoc(guestParticipantRef, {
        status: "left",
        leftAt: Date.now()
      }).catch(()=>{})
    );
  }

  if(hostParticipantRef){
    updates.push(
      updateDoc(hostParticipantRef, {
        status: "left",
        leftAt: Date.now()
      }).catch(()=>{})
    );
  }

  if(hostStream){
    hostStream.getTracks().forEach((track)=>track.stop());
  }

  if(guestPeer){
    guestPeer.close();
  }

  if(hostPeers.size){
    destroyAllHostPeers();
  }
});

setRoomStatusToReadyForJoin();

if(roomFromUrl){
  roomInput.value = normalizeRoomId(roomFromUrl);
}
