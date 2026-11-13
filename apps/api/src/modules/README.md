# Domain modules

Domain services expose public APIs from their root only. Cross-module deep imports are forbidden. A module never imports `app/`, another module's `server/` internals, or platform vendor SDKs.
