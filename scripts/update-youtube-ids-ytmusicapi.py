#!/usr/bin/env python3
"""
Update youtube-ids.txt using ytmusicapi for accurate YouTube Music search results.
Usage: python scripts/update-youtube-ids-ytmusicapi.py
"""
import re
from pathlib import Path

try:
    from ytmusicapi import YTMusic
except ImportError:
    print("ytmusicapi not installed. Run: pip install ytmusicapi")
    exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
IDS_FILE = REPO_ROOT / "public" / "realdac-songs" / "honey-singh" / "youtube-ids.txt"
ARTIST = "Yo Yo Honey Singh"

SONGS = [
    "Brown Rang",
    "Love Dose",
    "Blue Eyes",
    "Main Sharabi",
    "Lungi Dance",
    "First Kiss",
    "Dheere Dheere",
    "High Heels",
    "Sunny Sunny",
    "Desi Kalakaar",
    "Char Bottle Vodka",
    "Millionaire",
    "Malamaal",
    "Rounds N Ring",
    "Party All Night",
    "Dope Shope",
]


def extract_video_id(result):
    """Extract videoId from ytmusicapi search result."""
    if isinstance(result, dict):
        return result.get("videoId")
    return None


def main():
    yt = YTMusic()
    lines = []
    lines.append("# Yo Yo Honey Singh – YouTube video IDs (via ytmusicapi)")
    lines.append("# Format: song_name | VIDEO_ID | https://youtube.com/watch?v=VIDEO_ID")
    lines.append("")

    for song in SONGS:
        query = f"{ARTIST} {song}"
        try:
            results = yt.search(query, filter="songs", limit=5)
            vid = None
            for r in results:
                vid = extract_video_id(r)
                if vid:
                    break
            if not vid:
                # fallback: try videos filter
                results = yt.search(query, filter="videos", limit=5)
                for r in results:
                    vid = extract_video_id(r)
                    if vid:
                        break
            if vid:
                lines.append(f"{song} | {vid} | https://www.youtube.com/watch?v={vid}")
                print(f"  {song} -> {vid}")
            else:
                lines.append(f"# {song} | NOT_FOUND | # no videoId in search results")
                print(f"  {song} -> NOT_FOUND")
        except Exception as e:
            lines.append(f"# {song} | ERROR | # {e}")
            print(f"  {song} -> ERROR: {e}")

    lines.append("")
    lines.append("# Run: bash scripts/download-honey-singh.sh")
    IDS_FILE.write_text("\n".join(lines) + "\n")
    print(f"\nUpdated {IDS_FILE}")


if __name__ == "__main__":
    main()
