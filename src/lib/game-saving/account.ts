import type { AstroCookies } from 'astro'
import admin from 'firebase-admin'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { customAlphabet } from 'nanoid/async'
import { lazy } from '../utils/lazy'
import { generateGameName } from '../words'
import { isDark } from '../state'

const numberid = customAlphabet('0123456789')

const app = lazy(() => {
	if (admin.apps.length === 0) {
		return initializeApp({
			credential: admin.credential.cert(JSON.parse(Buffer.from(import.meta.env.FIREBASE_CREDENTIAL, 'base64').toString()))
		})
	} else {
		return admin.apps[0]!
	}
})
export const firestore = lazy(() => {
	const firestore = getFirestore(app)
	try {
		firestore.settings({ preferRest: true })
	} catch (error) {
		// Catch cursed "Firestore has already been initialized" error
		// console.error(error)
	}
	return firestore
})

export interface User {
	id: string
	createdAt: Timestamp
	email: string
	username: string | null
}

export interface Session {
	id: string
	createdAt: Timestamp
	userId: string
	full: boolean // Means they can access all games, not just unprotected access ones
}

export interface Game {
	id: string
	ownerId: string
	createdAt: Timestamp
	modifiedAt: Timestamp
	unprotected: boolean // Can be edited by partial user session (email only)
	name: string
	code: string
	tutorialName?: string
	tutorialIndex?: number
}

export interface LoginCode {
	id: string
	createdAt: Timestamp
	userId: string
}

export interface Snapshot {
	id: string
	createdAt: Timestamp
	gameId: string
	ownerId: string
	name: string
	ownerName: string
	code: string
}

export interface SnapshotData {
	id: string
	createdAt: Timestamp
	name: string
	ownerName: string
	code: string
}

export interface SessionInfo {
	session: Session
	user: User
}

export const getSession = async (cookies: AstroCookies): Promise<SessionInfo | null> => {
	if (!cookies.has('sprigSession')) return null
	const _session = await firestore.collection('sessions').doc(cookies.get('sprigSession').value!).get()
	if (!_session.exists) return null
	const session = { id: _session.id, ..._session.data() } as Session

	const _user = await firestore.collection('users').doc(session.userId).get()
	if (!_user.exists) {
		console.warn('Session with invalid user')
		await _session.ref.delete()
		return null
	}
	const user = { id: _user.id, ..._user.data() } as User

	return { session, user };
}

export const makeOrUpdateSession = async (cookies: AstroCookies, userId: string, authLevel: 'email' | 'code'): Promise<SessionInfo> => {
	const curSessionId = cookies.get('sprigSession').value
	const _curSession = curSessionId
		? await firestore.collection('sessions').doc(curSessionId).get()
		: null
	if (_curSession && _curSession.exists && _curSession.data()!.userId === userId) {
		await _curSession.ref.update({ full: authLevel === 'code' })
		return {
			session: { id: _curSession.id, ..._curSession.data() } as Session,
			user: (await getUser(userId))!
		}
	}

	const data = {
		createdAt: Timestamp.now(),
		userId,
		full: authLevel === 'code'
	}
	const _session = await firestore.collection('sessions').add(data)
	cookies.set('sprigSession', _session.id, {
		path: '/',
		maxAge: 60 * 60 * 24 * 365,
		httpOnly: true,
		sameSite: 'strict'
	})
	return {
		session: { id: _session.id, ...data } as Session,
		user: (await getUser(userId))!
	}
}

export const updateSessionAuthLevel = async (id: string, authLevel: 'email' | 'code'): Promise<void> => {
	await firestore.collection('sessions').doc(id).update({
		full: authLevel === 'code'
	})
}

export const getGame = async (id: string | undefined): Promise<Game | null> => {
	if (!id) return null
	const _game = await firestore.collection('games').doc(id).get()
	if (!_game.exists) return null
	return { id: _game.id, ..._game.data() } as Game
}

export const makeGame = async (ownerId: string, unprotected: boolean, name?: string, code?: string, tutorialName?: string, tutorialIndex?: number): Promise<Game> => {
	const data = {
		ownerId,
		createdAt: Timestamp.now(),
		modifiedAt: Timestamp.now(),
		unprotected,
		name: name ?? generateGameName(),
		code: code ?? '',
		tutorialName: tutorialName ?? null,
		tutorialIndex: tutorialIndex ?? null
	}
	const _game = await firestore.collection('games').add(data)
	return { id: _game.id, ...data } as Game
}

export const getUser = async (id: string): Promise<User | null> => {
	const _user = await firestore.collection('users').doc(id).get()
	if (!_user.exists) return null
	return { id: _user.id, ..._user.data() } as User
}

export const getUserByEmail = async (email: string): Promise<User | null> => {
	const _users = await firestore.collection('users').where('email', '==', email).limit(1).get()
	if (_users.empty) return null
	return { id: _users.docs[0]!.id, ..._users.docs[0]!.data() } as User
}

export const makeUser = async (email: string, username: string | null): Promise<User> => {
	const data = {
		email,
		username,
		createdAt: Timestamp.now()
	}
	const _user = await firestore.collection('users').add(data)
	return { id: _user.id, ...data } as User
}

export const makeLoginCode = async (userId: string): Promise<string> => {
	const code = await numberid(6)
	await firestore.collection('loginCodes').add({
		code,
		userId,
		createdAt: Timestamp.now()
	})
	return code
}

export const makeSnapshot = async (game: Game): Promise<Snapshot> => {
	const data = {
		gameId: game.id,
		ownerId: game.ownerId,
		name: game.name,
		ownerName: (await getUser(game.ownerId))!.username,
		code: game.code,
		createdAt: Timestamp.now()
	}
	const _snapshot = await firestore.collection('snapshots').add(data)
	return { id: _snapshot.id, ...data } as Snapshot
}

export const getSnapshotData = async (id: string): Promise<SnapshotData | null> => {
	const _snapshot = await firestore.collection('snapshots').doc(id).get()
	if (!_snapshot.exists) return null
	const snapshot = { id: _snapshot.id, ..._snapshot.data() } as Snapshot

	const game = await getGame(snapshot.gameId)
	const user = await getUser(snapshot.ownerId)

	return {
		id: snapshot.id,
		createdAt: snapshot.createdAt,
		name: game?.name ?? snapshot.name,
		ownerName: user?.username ?? snapshot.ownerName,
		code: snapshot.code
	}
}