import { db } from "./firebase.js";

import {
doc,
setDoc,
getDoc,
updateDoc,
onSnapshot,
collection,
addDoc,
getDocs,
deleteDoc
}
from
"https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const video = document.getElementById("video");
const host = document.getElementById("host");
const roomLink = document.getElementById("roomLink");
const shareBox = document.getElementById("shareBox");
const copyBtn = document.getElementById("copyBtn");
const join = document.getElementById("join");
const roomInput = document.getElementById("roomInput");

let peer = null;
let localStream = null;
let currentRoom = null;
let lastAnswer = "";
let hostRoomUnsub = null;
let hostGuestCandidatesUnsub = null;
let guestRoomUnsub = null;
let guestHostCandidatesUnsub = null;
let currentOfferSdp = "";
let currentOfferNonce = "";
let guestSessionId = "";
let lastGuestSessionId = "";
let reiniciandoHost = false;
let reiniciandoInvitado = false;

const params = new URLSearchParams(window.location.search);
const roomFromUrl = params.get("room");

function generarSala(){
return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generarSesion(){
return crypto.randomUUID();
}

async function limpiar(ref){
const snap = await getDocs(ref);
for(const d of snap.docs){
await deleteDoc(d.ref);
}
}

function destruirPeer(){
try{
peer?.close();
}
catch{}
peer = null;
}

function limpiarHostListeners(){
try{
hostRoomUnsub?.();
}
catch{}
hostRoomUnsub = null;

try{
hostGuestCandidatesUnsub?.();
}
catch{}
hostGuestCandidatesUnsub = null;
}

function limpiarInvitadoListeners(){
try{
guestRoomUnsub?.();
}
catch{}
guestRoomUnsub = null;

try{
guestHostCandidatesUnsub?.();
}
catch{}
guestHostCandidatesUnsub = null;
}

function esperarVideo(){
return new Promise((resolve)=>{
const revisar = ()=>{
if(video.readyState >= 2){
resolve();
}
else{
requestAnimationFrame(revisar);
}
};
revisar();
});
}

function crearPeer(){
destruirPeer();

peer = new RTCPeerConnection({
iceServers:[
{
urls:"stun:stun.l.google.com:19302"
}
]
});

peer.ontrack = async(event)=>{
try{
console.log("Video recibido");

const stream = event.streams[0];
if(!stream) return;

video.pause();
video.srcObject = null;

await new Promise((r)=>setTimeout(r, 300));

video.srcObject = stream;
video.autoplay = true;
video.playsInline = true;
video.muted = false;
video.volume = 1;

await esperarVideo();
await video.play();

console.log("Video iniciado");
}
catch(error){
console.log(error);
}
};

peer.oniceconnectionstatechange = ()=>{
console.log("ICE:", peer.iceConnectionState);
};

peer.onconnectionstatechange = ()=>{
console.log("Estado:", peer.connectionState);
};

return peer;
}

async function reiniciarHost(room){
if(reiniciandoHost) return;
reiniciandoHost = true;

try{
limpiarHostListeners();
destruirPeer();
lastAnswer = "";

await limpiar(collection(db, "rooms", room, "hostCandidates"));
await limpiar(collection(db, "rooms", room, "guestCandidates"));

await iniciarHost(room);
}
finally{
reiniciandoHost = false;
}
}

async function iniciarHost(room){
limpiarHostListeners();
crearPeer();

localStream.getVideoTracks().forEach((track)=>{
track.contentHint = "detail";
});

const senders = [];

localStream.getTracks().forEach((track)=>{
const sender = peer.addTrack(track, localStream);
senders.push(sender);
});

for(const sender of senders){
const track = sender.track;

if(track?.kind !== "video"){
continue;
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

await sender.setParameters(parameters);
}
catch(error){
console.log("No se pudieron fijar los parámetros de envío", error);
}
}

peer.onicecandidate = async(event)=>{
if(!event.candidate) return;

await addDoc(
collection(db, "rooms", room, "hostCandidates"),
event.candidate.toJSON()
);

console.log("ICE enviado");
};

const peerActivo = peer;

peer.onconnectionstatechange = ()=>{
console.log("Estado:", peer.connectionState);

if(peer === peerActivo && peer.connectionState === "failed"){
reiniciarHost(room);
}
};

hostGuestCandidatesUnsub = onSnapshot(
collection(db, "rooms", room, "guestCandidates"),
(snapshot)=>{
snapshot.docChanges().forEach(async(change)=>{
if(change.type !== "added") return;

try{
if(peer !== peerActivo) return;

await peer.addIceCandidate(
new RTCIceCandidate(change.doc.data())
);

console.log("ICE aplicado al host");
}
catch{}
});
}
);

const offer = await peer.createOffer();
await peer.setLocalDescription(offer);

currentOfferSdp = offer.sdp;
currentOfferNonce = generarSesion();

await updateDoc(
doc(db, "rooms", room),
{
offer:{
type:offer.type,
sdp:offer.sdp,
nonce:currentOfferNonce
},
answer:null
}
);

console.log("Offer creada");

hostRoomUnsub = onSnapshot(
doc(db, "rooms", room),
async(snapshot)=>{
try{
const data = snapshot.data();

if(data?.guestSessionId && data.guestSessionId !== lastGuestSessionId){
lastGuestSessionId = data.guestSessionId;

if(data.offerNonce === currentOfferNonce){
console.log("Nuevo invitado detectado, reiniciando host");
reiniciarHost(room);
return;
}
}

if(!data?.answer?.sdp) return;

if(data.answer.sdp === lastAnswer){
console.log("Answer ignorada");
return;
}

lastAnswer = data.answer.sdp;

if(peer.remoteDescription) return;

await peer.setRemoteDescription(
new RTCSessionDescription(data.answer)
);

console.log("Host conectado");
}
catch(error){
console.log(error);
}
}
);
}

async function iniciarInvitado(room){
if(reiniciandoInvitado) return;
reiniciandoInvitado = true;

limpiarInvitadoListeners();

const roomRef = doc(db, "rooms", room);
const snap = await getDoc(roomRef);
const data = snap.data();

if(!data?.offer){
reiniciandoInvitado = false;
return;
}

const offerNonceInicial = data.offerNonce || "";

guestSessionId = generarSesion();

await updateDoc(
roomRef,
{
guestSessionId,
answer:null
}
);

async function aplicarOferta(oferta){
try{
guestHostCandidatesUnsub?.();
guestHostCandidatesUnsub = null;

destruirPeer();
crearPeer();
currentOfferSdp = oferta.sdp;
currentOfferNonce = oferta.nonce || currentOfferNonce;

await limpiar(collection(db, "rooms", room, "guestCandidates"));

peer.onicecandidate = async(event)=>{
if(!event.candidate) return;

await addDoc(
collection(db, "rooms", room, "guestCandidates"),
event.candidate.toJSON()
);

console.log("ICE enviado");
};

guestHostCandidatesUnsub = onSnapshot(
collection(db, "rooms", room, "hostCandidates"),
(snapshot)=>{
snapshot.docChanges().forEach(async(change)=>{
if(change.type !== "added") return;

try{
await peer.addIceCandidate(
new RTCIceCandidate(change.doc.data())
);

console.log("ICE aplicado");
}
catch{}
});
}
);

await peer.setRemoteDescription(
new RTCSessionDescription(oferta)
);

const answer = await peer.createAnswer();
await peer.setLocalDescription(answer);

await updateDoc(
roomRef,
{
answer:{
type:answer.type,
sdp:answer.sdp
}
}
);

console.log("Answer creada");
}
catch(error){
console.log(error);
}
}

guestRoomUnsub = onSnapshot(
roomRef,
async(snapshot)=>{
const data = snapshot.data();

if(!data?.offer?.sdp) return;
if(reiniciandoInvitado) return;

if(data.offer.nonce === offerNonceInicial) return;

if(data.offer.sdp === currentOfferSdp && data.offer.nonce === currentOfferNonce) return;

console.log("Oferta lista, conectando o reconectando");

reiniciandoInvitado = true;
await aplicarOferta(data.offer);
reiniciandoInvitado = false;
}
);

if(data.offer.nonce !== offerNonceInicial){
await aplicarOferta(data.offer);
}

console.log("Invitado conectado");
reiniciandoInvitado = false;
}

host.onclick = async()=>{
currentRoom = generarSala();

console.log("Código generado:", currentRoom);

const calidadCaptura = {
video:{
width:{
ideal:1920,
max:1920
},
height:{
ideal:1080,
max:1080
},
frameRate:{
ideal:60,
max:60
}
},
audio:true
};

const calidadFallback = {
video:{
width:{
ideal:1280,
max:1280
},
height:{
ideal:720,
max:720
},
frameRate:{
ideal:60,
max:60
}
},
audio:true
};

try{
localStream = await navigator.mediaDevices.getDisplayMedia(calidadCaptura);
}
catch(error){
console.log("No se pudo pedir 1080p, usando 720p", error);
localStream = await navigator.mediaDevices.getDisplayMedia(calidadFallback);
}

const capturada = localStream.getVideoTracks()[0];

if(capturada){
capturada.contentHint = "motion";

try{
await capturada.applyConstraints({
width:{
ideal:1920,
max:1920
},
height:{
ideal:1080,
max:1080
},
frameRate:{
ideal:60,
max:60
}
});
}
catch(error){
console.log("No se pudo fijar 60 fps exactos", error);
}

console.log("Captura:", capturada.getSettings());
}

video.srcObject = localStream;

await setDoc(
doc(db, "rooms", currentRoom),
{
active:true,
created:Date.now()
}
);

await limpiar(
collection(db, "rooms", currentRoom, "hostCandidates")
);

await limpiar(
collection(db, "rooms", currentRoom, "guestCandidates")
);

console.log("Sala guardada");

await iniciarHost(currentRoom);

roomInput.value = currentRoom;
roomLink.value = `${window.location.origin}${window.location.pathname}?room=${currentRoom}`;
shareBox.style.display = "block";
};

join.onclick = ()=>{
const room = roomInput.value.trim().toUpperCase();
if(!room) return;

window.location = `?room=${room}`;
};

copyBtn.onclick = async()=>{
await navigator.clipboard.writeText(roomLink.value);

copyBtn.innerText = "Copiado ✓";

setTimeout(()=>{
copyBtn.innerText = "Copiar";
}, 1500);
};

if(roomFromUrl){
host.style.display = "none";
copyBtn.style.display = "none";
shareBox.style.display = "none";
roomInput.value = roomFromUrl;

iniciarInvitado(roomFromUrl);
}
