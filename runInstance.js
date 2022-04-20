const makeWASocket = require("./baileys/lib").default;
const {
  AnyMessageContent,
  fetchLatestBaileysVersion,
  delay,
  DisconnectReason,
  makeInMemoryStore,
  useSingleFileAuthState,
  downloadContentFromMessage,
} = require("./baileys/lib");
const path = require("path");
const fs = require("fs");
const Queue = require("bull");

const path_data = path.join(__dirname, "/store/data");
const path_auth = path.join(__dirname, "/store/auth");
const path_assets = path.join(__dirname, "/store/assets");

const { v4: uuidv4 } = require("uuid");
const slugify = require("./utils/stringToSlug");
const { writeFile } = require("fs/promises");

Array.prototype.forEachAsync = async function (fn) {
  for (let t of this) {
    await fn(t);
  }
};

// start a connection
const startSock = async (name) => {
  // fetch latest version of WA Web
  const q = new Queue(`${name}-queue`, {
    redis: {
      host: "127.0.0.1",
      port: 6379,
    },
  });

  q.empty();

  const slug = slugify(name);
  const store = makeInMemoryStore({});
  store.readFromFile(`${path_data}/${slug}.json`);
  setInterval(() => {
    store.writeToFile(`${path_data}/${slug}.json`);
  }, 10_000);

  const { state, saveState } = useSingleFileAuthState(
    `${path_auth}/${slug}.json`
  );
  const { version, isLatest } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: true,
    auth: state,
    // implement to handle retries
    getMessage: async (key) => {
      return {
        conversation: "hello",
      };
    },
  });

  store.bind(sock.ev);

  q.process(async (job, done) => {
    // await doJob(job.data.id, "q1")
    // await console.log(job.data)
    try {
      const { id, message, flag } = job.data;
      if (flag == "t") {
        await sendMessageWTyping(id, message);
      } else if (flag == "i") {
        await sendMessageWTyping(id, {
          image: fs.readFileSync(
            path.join(path_assets, `./image_${name}.jpeg`)
          ),
          caption: message.caption,
        });
      } else if (flag == "d") {
        await sendMessageWTyping(id, {
          document: fs.readFileSync(
            path.join(path_assets, `./doc_${name}.pdf`)
          ),
        });
      }
      done();
    } catch (error) {
      console.log(error);
      done(`Failed to send message to ${name}`);
    }
  });

  const forwardMessage = async (msg, flag = "t") => {
    console.log(msg);
    store.chats.all().map((chat) => {
      if (chat.name == "FUCKOFF") {
        q.add({
          message: msg,
          id: chat.id,
          name: chat.name,
          flag,
        });
      }
    });
  };

  const sendMessageWTyping = async (jid, msg) => {
    await sock.presenceSubscribe(jid);
    await delay(1000);

    await sock.sendPresenceUpdate("composing", jid);
    await delay(3000);

    await sock.sendPresenceUpdate("paused", jid);

    await sock.sendMessage(jid, msg);
  };

  sock.ev.on("chats.set", (item) =>
    console.log(`recv ${item.chats.length} chats (is latest: ${item.isLatest})`)
  );

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    // console.log(JSON.stringify(msg,undefined,2))
    if (!msg.message) return; // if there is no text or media message

    if (!msg.key.fromMe && m.type === "notify") {
      // check if message contains image
      const messageType = Object.keys(msg.message)[0];

      if (msg.key.remoteJid === "919560692374@s.whatsapp.net") {
        let groups = [];
        store.chats.all().map((chat) => {
          if (chat.name) {
            groups.push(chat.name);
          }
        });
        // if the message is an image

        switch (messageType) {
          case "conversation":
            return forwardMessage({
              text: `${msg.message.conversation.split("PING").pop()}`,
            });
          case "imageMessage":
            if (true) {
              const stream = await downloadContentFromMessage(
                msg.message.imageMessage,
                "image"
              );
              let buffer = Buffer.from([]);
              for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
              }
              await writeFile(`${path_assets}/image_${name}.jpeg`, buffer);
              //    return await sendMessageWTyping(msg.key.remoteJid, {
              //         image: fs.readFileSync(path.join(path_assets, `./image_${name}.jpeg`)),
              //         caption: msg.message.imageMessage.caption.split("PING").pop()
              //     })
              return forwardMessage(
                {
                  image: fs.readFileSync(
                    path.join(path_assets, `./image_${name}.jpeg`)
                  ),
                  caption: msg.message.imageMessage.caption,
                },
                "i"
              );
            }
          case "extendedTextMessage":
            return forwardMessage({
              ...msg.message.extendedTextMessage,
            });
          case "documentMessage":
            if (true) {
              const stream = await downloadContentFromMessage(
                msg.message.documentMessage,
                "document"
              );
              let buffer = Buffer.from([]);
              for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
              }
              await writeFile(`${path_assets}/doc_${name}.pdf`, buffer);
              return forwardMessage(
                {
                  document: fs.readFileSync(
                    path.join(path_assets, `./doc_${name}.pdf`)
                  ),
                },
                "d"
              );
            }
          default:
            return await sendMessageWTyping(msg.key.remoteJid, {
              text: `Invalid format`,
            });
        }
      }
    }
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      // reconnect if not logged out
      if (
        lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut
      ) {
        startSock(name);
      } else {
        console.log("connection closed");
      }
    }

    console.log("connection update", update);
  });
  // listen for when the auth credentials is updated
  sock.ev.on("creds.update", saveState);

  return sock;
};

startSock("kartik");

// console.log(__dirname)
