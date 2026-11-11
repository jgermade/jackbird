# The plugin is found by name from Rust (crates/player/src/lib.rs), and its arguments are read by
# reflection (Tauri's @InvokeArg): neither may be renamed or removed.
-keep class es.germade.jackbird.player.** { *; }
