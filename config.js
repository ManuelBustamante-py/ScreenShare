// Servidores ICE para WebRTC.
// STUN basta en la mayoría de redes domésticas. En redes corporativas o con
// NAT estricto la conexión directa puede fallar y hace falta un servidor TURN
// (Metered, Cloudflare Calls, un coturn propio...). Ojo: este repo es público,
// así que cualquier credencial que pongas aquí quedará visible.
export const ICE_SERVERS = [
  { urls:["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls:"stun:stun.cloudflare.com:3478" }
  // { urls:"turn:TU_SERVIDOR:3478", username:"usuario", credential:"clave" },
];
