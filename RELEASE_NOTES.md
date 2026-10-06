## What's new in v0.5.0

**Dismiss when objects stop moving**
- Peek now clears the overlay once every detected object has either left the frame or come to a stop, so a parked car no longer keeps the popup open until Frigate ends the event.
- If a stopped object starts moving again, the overlay comes back on its own.
- Turn it off from the menu bar or Settings ("Dismiss when stationary") to keep waiting for the event to end instead.

Thanks to @Volkor3-16 for the suggestion.
