const makeWASocket = require('./baileys/lib').default
const { AnyMessageContent, fetchLatestBaileysVersion, delay, DisconnectReason, makeInMemoryStore, useSingleFileAuthState } = require('./baileys/lib')
const path = require('path')
const fs = require('fs')
const path_data = path.join(__dirname, '/store/data');
const path_auth = path.join(__dirname, '/store/auth');
const path_assets = path.join(__dirname, '/store/assets');
const { v4: uuidv4 } = require('uuid');
const slugify  = require('./utils/stringToSlug');


const createNewSession = (name=`autoId_${uuidv4()}`)=> new Promise(async (resolve,reject)=>{

    try {
        // store, auth and socket configurations
        const slug = slugify(name)
        const store = makeInMemoryStore({})
        store.readFromFile(`${path_data}/${slug}.json`)
        setInterval(() => {
            store.writeToFile(`${path_data}/${slug}.json`)
        }, 10_000)

        const { state, saveState } = useSingleFileAuthState(`${path_auth}/${slug}.json`)
        const { version, isLatest } = await fetchLatestBaileysVersion()

        console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)
        // create the socket
        const sock = makeWASocket({
            version,
            printQRInTerminal: true,
            auth: state,
            // implement to handle retries
            getMessage: async key => {
                return {
                    conversation: 'hello'
                }
            }
        })
        store.bind(sock.ev)

        sock.ev.on('chats.set', async item => {
            resolve(sock)
        })

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update
            if (connection === 'close') {
                // reconnect if not logged out
                if ((lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
                    createNewSession(name)
                } else {
                    console.log('connection closed')
                }
            }

            console.log('connection update', update)
        })
        // listen for when the auth credentials is updated
        sock.ev.on('creds.update', saveState)


        console.log(slug)
    } catch (error) {
        console.log(error.message)
        reject(error.message)
    }

})



const go = async ()=>{
    await createNewSession("mikku")
}

go()