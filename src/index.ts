import { DurableObject } from "cloudflare:workers";
import seedrandom from 'seedrandom';

// Types for the card game
type Suit = "hearts" | "diamonds" | "clubs" | "spades";
type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A";

interface Card {
	suit: Suit;
	rank: Rank;
}

interface Player {
	id: string;
	name: string;
	hand: Card[];
	score: number;
	isBot: boolean;
}

interface GameState {
	gameId: string;
	players: Player[];
	currentPlayerIndex: number;
	deck: Card[];
	discardPile: Card[];
	status: "waiting" | "playing" | "finished";
	round: number;
}

interface GameMessage {
	type: "join" | "play_card" | "draw_card" | "game_state" | "game_over";
	playerId?: string;
	playerName?: string;
	card?: Card;
	gameState?: GameState;
	winner?: string;
}

/**
 * Card Game Durable Object - manages a single game instance
 */
export class CardGame extends DurableObject<Env> {
	private gameState: GameState;
	private rng: () => number;
	private clients: Map<string, WebSocket> = new Map();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// Seed with game ID for reproducible shuffles
		const seed = ctx.id.toString();
		this.rng = seedrandom(seed);

		this.gameState = {
			gameId: ctx.id.toString(),
			players: [],
			currentPlayerIndex: 0,
			deck: [],
			discardPile: [],
			status: "waiting",
			round: 1,
		};

		this.initializeDeck();
	}

	/**
	 * Initialize and shuffle the deck
	 */
	private initializeDeck(): void {
		const suits: Suit[] = ["hearts", "diamonds", "clubs", "spades"];
		const ranks: Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

		this.gameState.deck = [];

		for (const suit of suits) {
			for (const rank of ranks) {
				this.gameState.deck.push({ suit, rank });
			}
		}

		this.shuffleDeck();
	}

	/**
	 * Fisher-Yates shuffle algorithm
	 */
	private shuffleDeck(): void {
		const deck = this.gameState.deck;
		for (let i = deck.length - 1; i > 0; i--) {
			const j = Math.floor(this.rng() * (i + 1));
			[deck[i], deck[j]] = [deck[j], deck[i]];
		}
	}
	/**
	 * Handle a player joining the game
	 */
	async joinGame(playerId: string, playerName: string, isBot: boolean): Promise<void> {
		// Check if player already exists
		const existingPlayer = this.gameState.players.find((p) => p.id === playerId);
		if (existingPlayer) {
			throw new Error("Player already joined");
		}

		// Only allow up to 4 players
		if (this.gameState.players.length >= 4) {
			throw new Error("Game is full");
		}

		const player: Player = {
			id: playerId,
			name: playerName,
			hand: [],
			score: 0,
			isBot,
		};

		this.gameState.players.push(player);

		// Deal initial cards
		for (let i = 0; i < 5; i++) {
			if (this.gameState.deck.length > 0) {
				const card = this.gameState.deck.pop()!;
				player.hand.push(card);
			}
		}

		// Broadcast game state update
		this.broadcastGameState();

		// If all 4 players have joined and human player(s) exist, start the game
		if (this.gameState.players.length === 4 && !this.gameState.players.every((p) => p.isBot)) {
			this.startGame();
		}
	}

	/**
	 * Start the game
	 */
	private startGame(): void {
		this.gameState.status = "playing";
		// Draw first card to discard pile
		if (this.gameState.deck.length > 0) {
			const card = this.gameState.deck.pop()!;
			this.gameState.discardPile.push(card);
		}
		this.broadcastGameState();
		this.promptCurrentPlayer();
	}

	/**
	 * Handle a player playing a card
	 */
	async playCard(playerId: string, cardIndex: number): Promise<void> {
		const player = this.gameState.players.find((p) => p.id === playerId);
		if (!player) throw new Error("Player not found");

		const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
		if (currentPlayer.id !== playerId) {
			throw new Error("Not your turn");
		}

		if (cardIndex < 0 || cardIndex >= player.hand.length) {
			throw new Error("Invalid card index");
		}

		const card = player.hand[cardIndex];
		const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];

		// Simple validation: card must match suit or rank
		if (card.suit !== topCard.suit && card.rank !== topCard.rank) {
			throw new Error("Invalid play");
		}

		// Play the card
		player.hand.splice(cardIndex, 1);
		this.gameState.discardPile.push(card);

		// Award points (simple scoring)
		player.score += this.calculateCardValue(card);

		// Check for win condition
		if (player.hand.length === 0) {
			this.gameState.status = "finished";
			this.broadcastGameOver(player.name);
			return;
		}

		// Move to next player
		this.nextTurn();
		this.broadcastGameState();
		this.promptCurrentPlayer();
	}

	/**
	 * Handle a player drawing a card
	 */
	async drawCard(playerId: string): Promise<void> {
		const player = this.gameState.players.find((p) => p.id === playerId);
		if (!player) throw new Error("Player not found");

		const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
		if (currentPlayer.id !== playerId) {
			throw new Error("Not your turn");
		}

		if (this.gameState.deck.length === 0) {
			// Reshuffle discard pile (keep top card)
			if (this.gameState.discardPile.length > 1) {
				const topCard = this.gameState.discardPile.pop()!;
				this.gameState.deck = this.gameState.discardPile.splice(0);
				this.gameState.discardPile = [topCard];
				this.shuffleDeck();
			}
		}

		if (this.gameState.deck.length > 0) {
			const card = this.gameState.deck.pop()!;
			player.hand.push(card);
		}

		// Move to next player
		this.nextTurn();
		this.broadcastGameState();
		this.promptCurrentPlayer();
	}

	/**
	 * Move to the next player's turn
	 */
	private nextTurn(): void {
		this.gameState.currentPlayerIndex = (this.gameState.currentPlayerIndex + 1) % this.gameState.players.length;
	}

	/**
	 * Prompt the current player to make a move
	 */
	private promptCurrentPlayer(): void {
		const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
		if (currentPlayer.isBot) {
			// Simulate bot delay
			setTimeout(() => this.executeBotTurn(currentPlayer.id), 500 + Math.random() * 1000);
		}
	}

	/**
	 * Execute a bot player's turn
	 */
	private async executeBotTurn(botId: string): Promise<void> {
		const bot = this.gameState.players.find((p) => p.id === botId);
		if (!bot || this.gameState.status !== "playing") return;

		const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
		const validCards = bot.hand.filter((card) => card.suit === topCard.suit || card.rank === topCard.rank);

		if (validCards.length > 0) {
			const cardIndex = bot.hand.indexOf(validCards[Math.floor(Math.random() * validCards.length)]);
			await this.playCard(botId, cardIndex);
		} else {
			await this.drawCard(botId);
		}
	}

	/**
	 * Calculate card point value (simple scoring)
	 */
	private calculateCardValue(card: Card): number {
		const rankValues: Record<Rank, number> = {
			"2": 2,
			"3": 3,
			"4": 4,
			"5": 5,
			"6": 6,
			"7": 7,
			"8": 8,
			"9": 9,
			"10": 10,
			J: 11,
			Q: 12,
			K: 13,
			A: 14,
		};
		return rankValues[card.rank];
	}

	/**
	 * Broadcast current game state to all connected clients
	 */
	private broadcastGameState(): void {
		const message: GameMessage = {
			type: "game_state",
			gameState: this.gameState,
		};
		this.broadcast(message);
	}

	/**
	 * Broadcast game over message
	 */
	private broadcastGameOver(winner: string): void {
		const message: GameMessage = {
			type: "game_over",
			winner,
		};
		this.broadcast(message);
	}

	/**
	 * Broadcast a message to all connected clients
	 */
	private broadcast(message: GameMessage): void {
		for (const ws of this.clients.values()) {
			ws.send(JSON.stringify(message));
		}
	}

	/**
	 * Handle WebSocket connections from bots
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (request.headers.get("Upgrade") === "websocket") {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			const playerId = url.searchParams.get("playerId") || `bot_${Date.now()}`;
			const playerName = url.searchParams.get("playerName") || `Bot_${Math.random().toString(36).substring(2, 9)}`;
			const isBot = url.searchParams.get("isBot") === "true";

			this.clients.set(playerId, server);

			server.addEventListener("message", async (event) => {
				try {
					const message: GameMessage = JSON.parse(event.data);

					switch (message.type) {
						case "join":
							await this.joinGame(playerId, playerName, isBot);
							break;
						case "play_card":
							if (message.card !== undefined) {
								const cardIndex = this.gameState.players
									.find((p) => p.id === playerId)
									?.hand.findIndex((c) => c.suit === message.card!.suit && c.rank === message.card!.rank);
								if (cardIndex !== undefined && cardIndex >= 0) {
									await this.playCard(playerId, cardIndex);
								}
							}
							break;
						case "draw_card":
							await this.drawCard(playerId);
							break;
					}
				} catch (error) {
					server.send(JSON.stringify({ type: "error", message: (error as Error).message }));
				}
			});

			server.addEventListener("close", () => {
				this.clients.delete(playerId);
			});

			return new Response(null, { status: 101, webSocket: client });
		}

		return new Response("WebSocket required", { status: 400 });
	}
}

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */


export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/create-game") {
			// Create a new game instance
			const gameId = `game_${Date.now()}`;
			return new Response(JSON.stringify({ gameId, wsUrl: `/ws/${gameId}` }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.pathname.startsWith("/ws/")) {
			// Route to game Durable Object
			const gameId = url.pathname.split("/")[2];
			const stub = env.MY_DURABLE_OBJECT.getByName(gameId);
			return stub.fetch(request);
		}

		return new Response("Card Game API - Use /create-game to start a game", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
