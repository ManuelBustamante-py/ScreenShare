# ScreenShare

Compartir pantalla con audio entre navegadores, sin instalar nada. WebRTC punto a punto, con Firestore como canal de señalización, salas y chat. Es un sitio estático (GitHub Pages), sin build.

## Uso

- **Transmitir**: escribe tu nombre y pulsa *Crear sala y transmitir*. Si escribes un código, la sala se reutiliza (útil para tener siempre la misma, p. ej. `OFICINA`).
- **Ver**: abre el enlace de la sala o escribe el código y pulsa *Entrar a la sala*. Se aceptan enlaces completos pegados en el campo de código.
- **Modo**: *🎬 Película* prioriza la fluidez (1080p a 60 fps); *💼 Trabajo* prioriza la nitidez del texto (hasta 1440p a 30 fps). Se puede cambiar en plena transmisión.
- **Cambiar fuente**: cambia la ventana o pantalla compartida sin cortar a los espectadores.
- Si el anfitrión termina y vuelve a transmitir en la misma sala, los espectadores se reconectan solos.

### Atajos (mientras estás en una sala)

| Tecla | Acción |
|---|---|
| `F` / doble clic | Pantalla completa |
| `C` | Vista limpia, solo video (para recapturarla en Meet, Zoom o Teams) |
| `M` | Silenciar / activar sonido |
| `Esc` | Salir de la vista limpia |

### Parámetros de URL

| Parámetro | Efecto |
|---|---|
| `?room=CODIGO` | Rellena el código de sala |
| `&auto=1` | Entra automáticamente y espera aunque la sala aún no exista |
| `&clean=1` | Abre directamente en vista limpia |

Ejemplo para una PC o TV que solo debe mostrar la transmisión:
`https://<usuario>.github.io/ScreenShare/?room=OFICINA&auto=1&clean=1`

## Desarrollo local

Los módulos ES necesitan un servidor (no funciona abriendo el HTML con doble clic):

```
npx serve .
```

Compartir pantalla requiere `localhost` o HTTPS.

## Redes restrictivas

Solo hay servidores STUN configurados ([config.js](config.js)). Si alguno de los equipos está detrás de un firewall corporativo o NAT simétrico, la conexión puede no establecerse y hará falta un servidor TURN.

## Datos en Firestore

```
rooms/{code}                 active, sessionKey, hostName, hostSessionId, startedAt, endedAt
  participants/{id}          name, role, status, sessionKey, lastSeen, offer, answer
    hostCandidates/{id}
    guestCandidates/{id}
  messages/{id}              senderId, senderName, text, createdAt
```

`sessionKey` cambia cada vez que el anfitrión empieza a transmitir. Sirve para separar sesiones dentro de la misma sala.
