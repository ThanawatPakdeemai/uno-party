
import QRCode from "qrcode";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type Card = {
  id: string;
  color: string;
  value: string;
};

type Player = {
  id: string;
  name: string;
  token: string;
  hand: Card[];
  online: boolean;
  uno: boolean;
};

type Room = {
  id: string;
  name: string;
  password: string;
  owner: string;
  players: Player[];
  started: boolean;
  turn: number;
  direction: number;
  deck: Card[];
  discard: Card[];
  color: string;
  winner: string | null;
  pending: number;
  drawn: boolean;
  updated: number;
};

type SocketData = {
  roomId: string;
  token: string;
};

const rooms = new Map<string, Room>();
const connections = new Map<string, any>();

const colors = ["red", "blue", "green", "yellow"];

const json = (data: any, status = 200) =>
  Response.json(data, { status });

const fail = (message: string, status = 400) =>
  json({ error: message }, status);

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }

  return items;
}

function makeDeck(): Card[] {
  const cards: Card[] = [];

  for (const color of colors) {
    cards.push({
      id: randomUUID(),
      color,
      value: "0",
    });

    for (const value of [
      "1", "2", "3", "4", "5",
      "6", "7", "8", "9",
      "skip", "reverse", "+2",
    ]) {
      for (let i = 0; i < 2; i++) {
        cards.push({
          id: randomUUID(),
          color,
          value,
        });
      }
    }
  }

  for (let i = 0; i < 4; i++) {
    for (const value of ["wild", "+4"]) {
      cards.push({
        id: randomUUID(),
        color: "black",
        value,
      });
    }
  }

  return shuffle(cards);
}

function draw(room: Room, count: number): Card[] {
  const hand: Card[] = [];

  for (let i = 0; i < count; i++) {
    if (!room.deck.length) {
      const top = room.discard.pop();

      room.deck = shuffle(room.discard.splice(0));

      if (top) {
        room.discard = [top];
      }
    }

    const card = room.deck.pop();

    if (card) {
      hand.push(card);
    }
  }

  return hand;
}

function current(room: Room): Player {
  return room.players[room.turn];
}

function advance(room: Room, steps = 1): void {
  room.turn =
    (
      room.turn +
      room.direction * steps +
      room.players.length * 4
    ) % room.players.length;

  room.drawn = false;
}

function view(room: Room, player: Player) {
  return {
    id: room.id,
    name: room.name,
    owner: room.owner === player.id,
    started: room.started,
    turn: room.started ? current(room)?.id : null,
    direction: room.direction,
    top: room.discard[room.discard.length - 1] || null,
    color: room.color,
    pending: room.pending,
    winner: room.winner,
    hand: player.hand,
    drawn: room.drawn,

    players: room.players.map((item) => ({
      id: item.id,
      name: item.name,
      count: item.hand.length,
      online: item.online,
      uno: item.uno,
      owner: item.id === room.owner,
    })),
  };
}

function broadcast(room: Room): void {
  for (const player of room.players) {
    const socket = connections.get(player.token);

    if (socket) {
      try {
        socket.send(
          JSON.stringify({
            type: "state",
            state: view(room, player),
          })
        );
      } catch {
        // Ignore disconnected sockets.
      }
    }
  }
}

const server = Bun.serve<SocketData>({
  port: Number(process.env.PORT || 3001),
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ---------------------------
    // Static files
    // ---------------------------

    if (path === "/" || path === "/index.html") {
      return new Response(
        Bun.file(join(import.meta.dir, "public/index.html"))
      );
    }

    if (path === "/app.js") {
      return new Response(
        Bun.file(join(import.meta.dir, "public/app.js")),
        {
          headers: {
            "Content-Type": "text/javascript",
          },
        }
      );
    }

    if (path === "/style.css") {
      return new Response(
        Bun.file(join(import.meta.dir, "public/style.css")),
        {
          headers: {
            "Content-Type": "text/css",
          },
        }
      );
    }

    // ---------------------------
    // Generate QR Code
    // ---------------------------

    if (path === "/api/qr") {
      const target = url.searchParams.get("url") || "";

      if (!/^https?:\/\//i.test(target)) {
        return fail("Invalid URL");
      }

      const qrBuffer = await QRCode.toBuffer(target, {
        width: 280,
        margin: 2,
      });

      // Fix TypeScript TS2345:
      // Convert Node.js Buffer into a concrete ArrayBuffer.
      const qrArrayBuffer = Uint8Array.from(qrBuffer).buffer;

      return new Response(qrArrayBuffer, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        },
      });
    }

    // ---------------------------
    // Create room
    // ---------------------------

    if (path === "/api/rooms" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));

      const playerName = String(body.player || "")
        .trim()
        .slice(0, 22);

      if (!playerName) {
        return fail("กรุณากรอกชื่อผู้เล่น");
      }

      const roomId = randomUUID().slice(0, 6).toUpperCase();
      const token = randomUUID();
      const playerId = randomUUID();

      const player: Player = {
        id: playerId,
        name: playerName,
        token,
        hand: [],
        online: false,
        uno: false,
      };

      const room: Room = {
        id: roomId,
        name: String(body.name || "ห้อง UNO สุดป่วน")
          .trim()
          .slice(0, 40),
        password: String(body.password || "").slice(0, 60),
        owner: playerId,
        players: [player],
        started: false,
        turn: 0,
        direction: 1,
        deck: [],
        discard: [],
        color: "",
        winner: null,
        pending: 0,
        drawn: false,
        updated: Date.now(),
      };

      rooms.set(roomId, room);

      return json({
        room: roomId,
        token,
        playerId,
      });
    }

    // ---------------------------
    // Get room / Join room
    // ---------------------------

    const match = path.match(
      /^\/api\/rooms\/([A-Z0-9]+)(?:\/(join))?$/
    );

    if (match) {
      const room = rooms.get(match[1]);

      if (!room) {
        return fail("ไม่พบห้องนี้", 404);
      }

      if (req.method === "GET" && !match[2]) {
        return json({
          id: room.id,
          name: room.name,
          locked: Boolean(room.password),
          started: room.started,
          players: room.players.length,
        });
      }

      if (match[2] === "join" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));

        if (room.started) {
          return fail(
            "เกมเริ่มแล้ว ไม่สามารถเข้าร่วมได้"
          );
        }

        if (room.players.length >= 8) {
          return fail("ห้องเต็มแล้ว");
        }

        if (room.password !== String(body.password || "")) {
          return fail("รหัสผ่านห้องไม่ถูกต้อง", 403);
        }

        const playerName = String(body.player || "")
          .trim()
          .slice(0, 22);

        if (!playerName) {
          return fail("กรุณากรอกชื่อผู้เล่น");
        }

        const player: Player = {
          id: randomUUID(),
          name: playerName,
          token: randomUUID(),
          hand: [],
          online: false,
          uno: false,
        };

        room.players.push(player);
        room.updated = Date.now();

        broadcast(room);

        return json({
          room: room.id,
          token: player.token,
          playerId: player.id,
        });
      }
    }

    // ---------------------------
    // WebSocket upgrade
    // ---------------------------

    if (path === "/ws") {
      const roomId = url.searchParams.get("room") || "";
      const token = url.searchParams.get("token") || "";

      const room = rooms.get(roomId);

      const player = room?.players.find(
        (item) => item.token === token
      );

      if (!room || !player) {
        return fail("Unauthorized", 401);
      }

      if (
        server.upgrade(req, {
          data: {
            roomId,
            token,
          },
        })
      ) {
        return;
      }

      return fail("WebSocket error");
    }

    return fail("Not found", 404);
  },

  // ---------------------------
  // WebSocket handlers
  // ---------------------------

  websocket: {
    open(ws) {
      connections.set(ws.data.token, ws);

      const room = rooms.get(ws.data.roomId);

      if (!room) return;

      const player = room.players.find(
        (item) => item.token === ws.data.token
      );

      if (player) {
        player.online = true;
        room.updated = Date.now();
        broadcast(room);
      }
    },

    close(ws) {
      if (connections.get(ws.data.token) === ws) {
        connections.delete(ws.data.token);
      }

      const room = rooms.get(ws.data.roomId);

      const player = room?.players.find(
        (item) => item.token === ws.data.token
      );

      if (room && player) {
        player.online = false;
        broadcast(room);
      }
    },

    message(ws, raw) {
      const room = rooms.get(ws.data.roomId);

      if (!room) return;

      const player = room.players.find(
        (item) => item.token === ws.data.token
      );

      if (!player) return;

      let message: any;

      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      const sendError = (text: string) => {
        ws.send(
          JSON.stringify({
            type: "error",
            message: text,
          })
        );
      };

      const isOwner = room.owner === player.id;

      try {
        switch (message.type) {
          case "rename": {
            if (!isOwner || room.started) {
              throw Error(
                "เฉพาะเจ้าของห้องแก้ไขได้ก่อนเริ่มเกม"
              );
            }

            room.name =
              String(message.name || "")
                .trim()
                .slice(0, 40) || room.name;

            break;
          }

          case "password": {
            if (!isOwner || room.started) {
              throw Error(
                "เฉพาะเจ้าของห้องแก้ไขได้ก่อนเริ่มเกม"
              );
            }

            room.password = String(
              message.password || ""
            ).slice(0, 60);

            break;
          }

          case "delete": {
            if (!isOwner) {
              throw Error("เฉพาะเจ้าของห้องลบได้");
            }

            for (const item of room.players) {
              const socket = connections.get(item.token);

              socket?.send(
                JSON.stringify({ type: "deleted" })
              );

              socket?.close();
            }

            rooms.delete(room.id);
            return;
          }

          case "start": {
            if (
              !isOwner ||
              room.started ||
              room.players.length < 2
            ) {
              throw Error(
                "ต้องมีผู้เล่นอย่างน้อย 2 คน"
              );
            }

            room.started = true;
            room.winner = null;
            room.deck = makeDeck();
            room.discard = [];
            room.direction = 1;
            room.turn = 0;
            room.pending = 0;
            room.drawn = false;

            for (const item of room.players) {
              item.hand = draw(room, 7);
              item.uno = false;
            }

            const starter = room.deck.findIndex(
              (card) =>
                card.color !== "black" &&
                /^\d$/.test(card.value)
            );

            const firstCard = room.deck.splice(
              starter,
              1
            )[0];

            room.discard.push(firstCard);
            room.color = firstCard.color;

            break;
          }

          case "play": {
            if (
              !room.started ||
              room.winner ||
              current(room) !== player
            ) {
              throw Error("ยังไม่ถึงตาของคุณ");
            }

            if (room.pending) {
              throw Error(
                "ต้องจั่วไพ่ตามบทลงโทษ"
              );
            }

            const cardIndex = player.hand.findIndex(
              (card) => card.id === message.cardId
            );

            if (cardIndex < 0) {
              throw Error("ไม่พบไพ่");
            }

            const card = player.hand[cardIndex];

            const top =
              room.discard[room.discard.length - 1];

            const playable =
              card.color === "black" ||
              card.color === room.color ||
              card.value === top.value;

            if (!playable) {
              throw Error("ไพ่ใบนี้ลงไม่ได้");
            }

            if (
              card.value === "+4" &&
              player.hand.some(
                (item) => item.color === room.color
              )
            ) {
              throw Error(
                "+4 ใช้ได้เมื่อไม่มีไพ่สีปัจจุบัน"
              );
            }

            const chosenColor = String(
              message.color || ""
            );

            if (
              card.color === "black" &&
              !colors.includes(chosenColor)
            ) {
              throw Error("กรุณาเลือกสี");
            }

            player.hand.splice(cardIndex, 1);
            room.discard.push(card);

            room.color =
              card.color === "black"
                ? chosenColor
                : card.color;

            player.uno =
              player.hand.length === 1 &&
              message.uno === true;

            if (player.hand.length === 0) {
              room.winner = player.id;
              break;
            }

            if (card.value === "reverse") {
              room.direction *= -1;

              advance(
                room,
                room.players.length === 2 ? 2 : 1
              );
            } else if (card.value === "skip") {
              advance(room, 2);
            } else if (
              card.value === "+2" ||
              card.value === "+4"
            ) {
              advance(room);

              const victim = current(room);

              victim.hand.push(
                ...draw(
                  room,
                  card.value === "+2" ? 2 : 4
                )
              );

              victim.uno = false;

              advance(room);
            } else {
              advance(room);
            }

            break;
          }

          case "draw": {
            if (
              !room.started ||
              room.winner ||
              current(room) !== player
            ) {
              throw Error("ยังไม่ถึงตาของคุณ");
            }

            if (room.drawn) {
              throw Error("จั่วไปแล้ว");
            }

            player.hand.push(...draw(room, 1));
            player.uno = false;
            room.drawn = true;

            break;
          }

          case "pass": {
            if (
              !room.started ||
              current(room) !== player ||
              !room.drawn
            ) {
              throw Error("ต้องจั่วก่อนผ่าน");
            }

            advance(room);
            break;
          }

          case "uno": {
            if (player.hand.length === 1) {
              player.uno = true;
            }

            break;
          }

          case "catch": {
            const target = room.players.find(
              (item) => item.id === message.target
            );

            if (
              !target ||
              target === player ||
              target.hand.length !== 1 ||
              target.uno
            ) {
              throw Error("จับ UNO ไม่สำเร็จ");
            }

            target.hand.push(...draw(room, 2));
            break;
          }

          case "restart": {
            if (!isOwner || !room.winner) {
              throw Error(
                "ยังเริ่มเกมใหม่ไม่ได้"
              );
            }

            room.started = false;
            room.winner = null;

            for (const item of room.players) {
              item.hand = [];
              item.uno = false;
            }

            break;
          }

          default:
            return;
        }

        room.updated = Date.now();
        broadcast(room);
      } catch (error: any) {
        sendError(
          error.message || "เกิดข้อผิดพลาด"
        );
      }
    },
  },
});

// ---------------------------
// Cleanup inactive rooms
// ---------------------------

setInterval(() => {
  const now = Date.now();

  for (const [id, room] of rooms) {
    const inactiveFor = now - room.updated;

    if (inactiveFor > 24 * 60 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}, 60 * 60 * 1000);

console.log(
  `UNO Party running at http://localhost:${server.port}`
);
