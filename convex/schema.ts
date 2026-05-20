import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const realdacRoomsTable = defineTable({
  roomCode: v.string(),
  currentTrack: v.string(),
  currentAlbum: v.string(),
  currentTrackName: v.optional(v.string()),
  updatedAt: v.number(),
})
  .index("by_room_code", ["roomCode"]);

export default defineSchema({
  realdacRooms: realdacRoomsTable,
});
