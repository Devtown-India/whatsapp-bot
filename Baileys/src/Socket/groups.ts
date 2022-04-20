import { proto } from '../../WAProto'
import { GroupMetadata, ParticipantAction, SocketConfig } from '../Types'
import { generateMessageID } from '../Utils'
import { BinaryNode, getBinaryNodeChild, getBinaryNodeChildren, jidEncode, jidNormalizedUser } from '../WABinary'
import { makeSocket } from './socket'

export const makeGroupsSocket = (config: SocketConfig) => {
	const sock = makeSocket(config)
	const { query } = sock

	const groupQuery = async(jid: string, type: 'get' | 'set', content: BinaryNode[]) => (
		query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid,
			},
			content
		})
	)

	const groupMetadata = async(jid: string) => {
		const result = await groupQuery(
			jid,
			'get',
			[ { tag: 'query', attrs: { request: 'interactive' } } ]
		)
		return extractGroupMetadata(result)
	}

	return {
		...sock,
		groupMetadata,
		groupCreate: async(subject: string, participants: string[]) => {
			const key = generateMessageID()
			const result = await groupQuery(
				'@g.us',
				'set',
				[
					{
						tag: 'create',
						attrs: {
							subject,
							key
						},
						content: participants.map(jid => ({
							tag: 'participant',
							attrs: { jid }
						}))
					}
				]
			)
			return extractGroupMetadata(result)
		},
		groupLeave: async(id: string) => {
			await groupQuery(
				'@g.us',
				'set',
				[
					{
						tag: 'leave',
						attrs: { },
						content: [
							{ tag: 'group', attrs: { id } }
						]
					}
				]
			)
		},
		groupUpdateSubject: async(jid: string, subject: string) => {
			await groupQuery(
				jid,
				'set',
				[
					{
						tag: 'subject',
						attrs: { },
						content: Buffer.from(subject, 'utf-8')
					}
				]
			)
		},
		groupParticipantsUpdate: async(
			jid: string,
			participants: string[],
			action: ParticipantAction
		) => {
			const result = await groupQuery(
				jid,
				'set',
				participants.map(
					jid => ({
						tag: action,
						attrs: { },
						content: [{ tag: 'participant', attrs: { jid } }]
					})
				)
			)
			const node = getBinaryNodeChild(result, action)
			const participantsAffected = getBinaryNodeChildren(node!, 'participant')
			return participantsAffected.map(p => p.attrs.jid)
		},
		groupUpdateDescription: async(jid: string, description?: string) => {
			const metadata = await groupMetadata(jid)
			const prev = metadata.descId ?? null

			await groupQuery(
				jid,
				'set',
				[
					{
						tag: 'description',
						attrs: {
							...(description ? { id: generateMessageID() } : { delete: 'true' }),
							...(prev ? { prev } : {})
						},
						content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : null
					}
				]
			)
		},
		groupInviteCode: async(jid: string) => {
			const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode.attrs.code
		},
		groupRevokeInvite: async(jid: string) => {
			const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode.attrs.code
		},
		groupAcceptInvite: async(code: string) => {
			const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const result = getBinaryNodeChild(results, 'group')
			return result.attrs.jid
		},
		groupAcceptInviteV4: async(jid: string, inviteMessage: proto.IGroupInviteMessage) => {
			const results = await groupQuery(inviteMessage.groupJid, 'set', [{ tag: 'accept', attrs: {
				code: inviteMessage.inviteCode,
				expiration: inviteMessage.inviteExpiration.toString(),
				admin: jid } }])
			return results.attrs.from
		},
		groupToggleEphemeral: async(jid: string, ephemeralExpiration: number) => {
			const content: BinaryNode = ephemeralExpiration ?
				{ tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } } :
				{ tag: 'not_ephemeral', attrs: { } }
			await groupQuery(jid, 'set', [content])
		},
		groupSettingUpdate: async(jid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') => {
			await groupQuery(jid, 'set', [ { tag: setting, attrs: { } } ])
		},
		groupFetchAllParticipating: async() => {
			const result = await query({
				tag: 'iq',
				attrs: {
					to: '@g.us',
					xmlns: 'w:g2',
					type: 'get',
				},
				content: [
					{
						tag: 'participating',
						attrs: { },
						content: [
							{ tag: 'participants', attrs: { } },
							{ tag: 'description', attrs: { } }
						]
					}
				]
			})
			const data: { [_: string]: GroupMetadata } = { }
			const groupsChild = getBinaryNodeChild(result, 'groups')
			if(groupsChild) {
				const groups = getBinaryNodeChildren(groupsChild, 'group')
				for(const groupNode of groups) {
					const meta = extractGroupMetadata({
						tag: 'result',
						attrs: { },
						content: [groupNode]
					})
					data[meta.id] = meta
				}
			}

			return data
		}
	}
}


export const extractGroupMetadata = (result: BinaryNode) => {
	const group = getBinaryNodeChild(result, 'group')
	const descChild = getBinaryNodeChild(group, 'description')
	let desc: string | undefined
	let descId: string | undefined
	if(descChild) {
		desc = getBinaryNodeChild(descChild, 'body')?.content as string
		descId = descChild.attrs.id
	}

	const groupId = group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us')
	const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
	const metadata: GroupMetadata = {
		id: groupId,
		subject: group.attrs.subject,
		creation: +group.attrs.creation,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		desc,
		descId,
		restrict: !!getBinaryNodeChild(group, 'locked'),
		announce: !!getBinaryNodeChild(group, 'announcement'),
		participants: getBinaryNodeChildren(group, 'participant').map(
			({ attrs }) => {
				return {
					id: attrs.jid,
					admin: attrs.type || null as any,
				}
			}
		),
		ephemeralDuration: eph ? +eph : undefined
	}
	return metadata
}
