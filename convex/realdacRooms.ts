/**
 * RealDac rooms – real-time track/album sync via Convex
 * Anyone in a room can change the track; updates propagate to all clients.
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

/**
 * Get room state by room code (real-time subscription).
 */
export const getByRoomCode = query({
  args: { roomCode: v.string() },
  handler: async (ctx, { roomCode }) => {
    return await ctx.db
      .query("realdacRooms")
      .withIndex("by_room_code", (q) => q.eq("roomCode", roomCode))
      .first();
  },
});

/**
 * Update the current track for a room. Creates doc if none exists.
 */
export const updateTrack = mutation({
  args: {
    roomCode: v.string(),
    currentTrack: v.string(),
    currentAlbum: v.string(),
    currentTrackName: v.optional(v.string()),
  },
  handler: async (ctx, { roomCode, currentTrack, currentAlbum, currentTrackName }) => {
    if (!roomCode || typeof roomCode !== "string" || roomCode.trim() === "") {
      throw new Error("realdacRooms.updateTrack: roomCode is required");
    }
    if (!currentTrack || typeof currentTrack !== "string") {
      throw new Error("realdacRooms.updateTrack: currentTrack is required");
    }
    if (!currentAlbum || typeof currentAlbum !== "string") {
      throw new Error("realdacRooms.updateTrack: currentAlbum is required");
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("realdacRooms")
      .withIndex("by_room_code", (q) => q.eq("roomCode", roomCode))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        currentTrack,
        currentAlbum,
        ...(currentTrackName != null && { currentTrackName }),
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("realdacRooms", {
      roomCode: roomCode.trim(),
      currentTrack,
      currentAlbum,
      ...(currentTrackName != null && { currentTrackName }),
      updatedAt: now,
    });
  },
});
