// mautrix-telegram - A Matrix-Telegram puppeting bridge
// Copyright (C) 2017 Tulir Asokan
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
const pkg = require("../package.json")
const os = require("os")
const telegram = require("telegram-mtproto")
const TelegramPeer = require("./telegram-peer")

/**
 * TelegramPuppet represents a Telegram account being controlled from Matrix.
 */
class TelegramPuppet {
	constructor(app, {userID, matrixUser, data, api_hash, api_id, server_config, api_config}) {
		this._client = undefined
		this.userID = userID
		this.matrixUser = matrixUser
		this.data = data

		this.app = app

		this.serverConfig = Object.assign({}, server_config)

		this.apiHash = api_hash
		this.apiID = api_id

		this.puppetStorage = {
			get: async (key) => {
				let value = this.data[key]
				return value
			},
			set: async (key, value) => {
				if (this.data[key] === value) {
					return
				}

				this.data[key] = value
				await this.matrixUser.save()
			},
			remove: async (...keys) => {
				keys.forEach((key) => delete this.data[key])
				await this.matrixUser.save()
			},
			clear: async () => {
				this.data = {}
				await this.matrixUser.save()
			},
		}

		this.apiConfig = Object.assign({}, {
			app_version: pkg.version,
			lang_code: "en",
			api_id: api_id,
			initConnection : 0x69796de9,
			layer: 57,
			invokeWithLayer: 0xda9b0d0d,
		}, api_config)

		if (this.data.dc && this.data[`dc${this.data.dc}_auth_key`]) {
			this.listen()
		}
	}

	static fromSubentry(app, matrixUser, data) {
		const userID = data.userID
		delete data.userID
		return new TelegramPuppet(app, Object.assign({
			userID,
			matrixUser,
			data,
		}, app.config.telegram))
	}

	toSubentry() {
		return Object.assign({
			userID: this.userID,
		}, this.data)
	}

	get client() {
		if (!this._client) {
			const self = this
			this._client = telegram.MTProto({
				api: this.apiConfig,
				server: this.serverConfig,
				app: { storage: this.puppetStorage },
			})
		}
		return this._client
	}

	async checkPhone(phone_number) {
		try {
			const status = this.client("auth.checkPhone", { phone_number })
			if (status.phone_registered) {
				return "registered"
			}
			return "unregistered"
		} catch (err) {
			if (err.message === "PHONE_NUMBER_INVALID") {
				return "invalid"
			}
			throw err
		}
	}

	sendCode(phone_number) {
		return this.client("auth.sendCode", {
			phone_number,
			current_number: true,
			api_id: this.apiID,
			api_hash: this.apiHash,
		})
	}

	logOut() {
		return this.client("auth.logOut")
	}

	async signIn(phone_number, phone_code_hash, phone_code) {
		try {
			const result = await
				this.client("auth.signIn", {
					phone_number, phone_code, phone_code_hash,
				})
			return this.signInComplete(result)
		} catch (err) {
			if (err.message !== "SESSION_PASSWORD_NEEDED") {
				throw err
			}
			const password = await
				this.client("account.getPassword", {})
			return {
				status: "need-password",
				hint: password.hint,
				salt: password.current_salt,
			}
		}
	}

	async checkPassword(password_hash) {
		const result = await this.client("auth.checkPassword", { password_hash })
		return this.signInComplete(result)
	}

	getDisplayName() {
		if (this.data.firstName || this.data.lastName) {
			return `${this.data.firstName} ${this.data.lastName}`
		} else if (this.data.username) {
			return this.data.username
		}
		return this.data.phone_number
	}

	signInComplete(data) {
		this.userID = data.user.id
		this.data.username = data.user.username
		this.data.firstName = data.user.first_name
		this.data.lastName = data.user.last_name
		this.data.phoneNumber = data.user.phone_number
		this.matrixUser.save()
		this.listen()
		return {
			status: "ok",
		}
	}

	async sendMessage(peer, message) {
		const result = await this.client("messages.sendMessage", {
			peer: peer.toInputPeer(),
			message,
			random_id: ~~(Math.random() * (1<<30)),
		})
		return result
	}

	handleMessage(message) {
		console.log(
			`Received message from ${message.from.id} to ${message.to.type.replace("user", "1-1 chat")}${message.to.type === "user" ? "" : " " + message.to.id}: ${message.text}`)
	}

	onUpdate(update) {
		if (!update) {
			console.log("Oh noes! Empty update")
			return
		}
		switch(update._) {
			case "updateUserStatus":
				console.log(update.user_id, "is now", update.status._.substr("userStatus".length))
				break
			case "updateUserTyping":
				console.log(update.user_id, "is typing in a 1-1 chat")
				break
			case "updateChatUserTyping":
				console.log(update.user_id, "is typing in", update.chat_id)
				break
			case "updateShortMessage":
				this.handleMessage({
					from: this.app.getTelegramUser(update.user_id),
					to: new TelegramPeer("user", update.user_id),
					text: update.message,
				})
				break
			case "updateShortChatMessage":
				this.handleMessage({
					from: this.app.getTelegramUser(update.user_id),
					to: new TelegramPeer("chat", update.chat_id),
					text: update.message,
				})
				break
			case "updateNewMessage":
				update = update.message // Message defined at message#90dddc11 in layer 71
				this.handleMessage({
					from: update.from_id,
					to: TelegramPeer.fromTelegramData(update.to_id),
					text: update.message,
				})
				break
			default:
				console.log(`Update of type ${update._} received:\n${JSON.stringify(update, "", "  ")}`)
		}
	}

	handleUpdate(data) {
		try {
			switch (data._) {
				case "updateShort":
					this.onUpdate(data.update)
					break
				case "updates":
					for (const update of data.updates) {
						this.onUpdate(update)
					}
					break
				case "updateShortMessage":
				case "updateShortChatMessage":
					this.onUpdate(data)
					break
				default:
					console.log("Unrecognized update type:", data._)
			}
		} catch (err) {
			console.error("Error handling update:", err)
			console.log(e.stack)
		}
	}

	async listen() {
		const client = this.client
		client.on("update", data => this.handleUpdate(data))
		if (client.bus) {
			client.bus.untypedMessage.observe(data => this.handleUpdate(data.message))
		}

		try {
			console.log("Updating online status...")
			//const statusUpdate = await client("account.updateStatus", { offline: false })
			//console.log(statusUpdate)
			console.log("Fetching initial state...")
			const state = await client("updates.getState", {})
			console.log("Initial state:", state)
		} catch (err) {
			console.error("Error getting initial state:", err)
		}
		try {
			console.log("Updating contact list...")
			const changed = await this.matrixUser.syncContacts()
			if (!changed) {
				console.log("Contacts were up-to-date")
			} else {
				console.log("Contacts updated")
			}
		} catch (err) {
			console.error("Failed to update contacts:", err)
		}
		try {
			console.log("Syncing dialogs...")
			await this.matrixUser.syncDialogs()
		} catch (err) {
			console.error("Failed to sync dialogs:", err)
		}
		setInterval(async () => {
			try {
				const state = client("updates.getState", {})
				// TODO use state?
			} catch (err) {
				console.error("Error updating state:", err)
			}
		}, 5000)
	}
}

module.exports = TelegramPuppet