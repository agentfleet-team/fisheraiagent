"""Print MP3 duration in seconds (mutagen). usage: python duration.py <file.mp3>"""
import sys
from mutagen.mp3 import MP3

try:
    print(round(MP3(sys.argv[1]).info.length, 2))
except Exception as e:
    print(f"error: {e}", file=sys.stderr)
    print(0)
