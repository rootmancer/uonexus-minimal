// SPDX-License-Identifier: BSD-2-Clause

using ClassicUO.Assets;
using ClassicUO.Configuration;
using ClassicUO.Game.Data;
using ClassicUO.Game.GameObjects;
using ClassicUO.Game.Map;
using ClassicUO.Game.Managers;
using ClassicUO.Game.UI.Gumps;
using ClassicUO.Input;
using ClassicUO.Network;
using ClassicUO.Renderer;
using ClassicUO.Resources;
using ClassicUO.Utility;
using ClassicUO.Utility.Logging;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using SDL3;
using System;
using System.Collections.Generic;
using System.Net.Sockets;

namespace ClassicUO.Game.Scenes
{
    internal partial class GameScene : Scene
    {
        private static readonly Func<BlendState> _darknessBlend = new(() =>
        {
            return new BlendState
            {
                ColorSourceBlend = Blend.Zero,
                ColorDestinationBlend = Blend.SourceColor,
                ColorBlendFunction = BlendFunction.Add
            };
        });

        private static readonly Func<BlendState> _altLightsBlend = new(() =>
        {
            return new BlendState
            {
                ColorSourceBlend = Blend.DestinationColor,
                ColorDestinationBlend = Blend.One,
                ColorBlendFunction = BlendFunction.Add
            };
        });

#if BROWSER_WASM
        // v0.3.36 lag diagnostic state. See Update() for the rationale.
        // Static so the timing helpers don't allocate per Update() call —
        // the user-facing log is gated by `>= 5 ms` and rate-limited per
        // label by 500 ms. The Dictionary stays bounded (one entry per
        // labelled checkpoint, ~7 entries total). Strip in v0.3.37.
        private static readonly System.Diagnostics.Stopwatch _lagSw = new System.Diagnostics.Stopwatch();
        private static readonly Dictionary<string, long> _lagDiagLastLog = new Dictionary<string, long>();
        // v0.3.36-bis: threshold dropped 5 ms → 3 ms after the first diag pass
        // showed only AnimStatics surfacing while 33/37 long-frames had no
        // labelled cause. Cooldown bumped 500 ms → 1000 ms to compensate
        // for the looser threshold so the dev console stays readable.
        private const long LagThresholdMs = 3;
        private const long LagCooldownMs = 1000;
        // v0.4.62 diag: any single label that crosses 100 ms in one
        // tick bypasses the cooldown so we never miss a real spike.
        // The original 1 s cooldown was eating evidence of the
        // upd=453 ms server-packet-flood post-teleport — each affected
        // label fired once at session start (well under 100 ms) and
        // then got suppressed for the rest of the session even when
        // it spiked to 400+ ms on heavy iters.
        private const long LagHeavyAlwaysLogMs = 100;
        private static void LagCheckpoint(string label)
        {
            long ms = _lagSw.ElapsedMilliseconds;
            if (ms >= LagThresholdMs)
            {
                long now = Environment.TickCount64;
                bool heavy = ms >= LagHeavyAlwaysLogMs;
                if (heavy || !_lagDiagLastLog.TryGetValue(label, out long last) || now - last >= LagCooldownMs)
                {
                    _lagDiagLastLog[label] = now;
                    Console.WriteLine($"[lag-diag] {label} took={ms}ms{(heavy ? " HEAVY" : "")}");
                }
            }
            _lagSw.Restart();
        }
#endif

        private const float MAX_LAYER_DEPTH = 0x8000;
        private uint _time_cleanup = Time.Ticks + 5000;
        private bool _alphaChanged;
        private long _alphaTimer;
        private bool _forceStopScene;
        private HealthLinesManager _healthLinesManager;

        private Point _lastSelectedMultiPositionInHouseCustomization;
        private int _lightCount;
        private readonly LightData[] _lights = new LightData[
            LightsLoader.MAX_LIGHTS_DATA_INDEX_COUNT
        ];

#if BROWSER_WASM
        // v0.4.12 fix the actual flicker.
        // K_static_mesh count from the LAST cache miss. In v0.4.10 we
        // preserved _lightCount across cache hits so Path B (in
        // DrawRenderLists, runs every frame) wouldn't lose its writes.
        // But Path B writes at index `_lightCount` and increments,
        // which on consecutive cache hits APPENDS new entries to
        // indices BEYOND the previous frame's range, accumulating
        // ghost-light entries from older frames at outdated positions.
        // PrepareLightsRendering iterates [0..count-1] every frame and
        // happily draws all the ghosts.
        //
        // v0.4.12: snapshot _lightCount at the end of the chunk loop
        // (= K_static_mesh, since Path A just finished). On the next
        // cache hit, restore _lightCount to that value before
        // returning from FillGameObjectList. Path B then writes its
        // K_dyn entries at indices K_static_mesh..K_static_mesh+K_dyn-1,
        // OVERWRITING the previous frame's Path B slots instead of
        // appending. End-of-frame _lightCount stays steady at K_total.
        // No accumulation, no ghosts. PrepareLightsRendering at top of
        // next frame draws the same K_total lights every time.
        private int _lightCountAfterChunkLoop;

        // v0.4.11 lights-diag — instrumentation only.
        // Hypothesis space for the "every-light flickers like a fluorescent"
        // bug that survived v0.4.10's _lightCount-reset-relocation:
        //   (A) cache hits sneak in between the [chunks-diff]-logged
        //       misses, leaving _lightCount stale and dropping Path A
        //       (chunk-mesh) lights every other frame.
        //   (B) cache misses every frame as suspected, but K_total itself
        //       varies frame-to-frame because one of the AddLight call
        //       paths gates on _alphaChanged or AlphaHue and toggles.
        // We sample _lightCount AT TOP of PrepareLightsRendering (before
        // any draw work, after PathA+PathB from previous frame have
        // accumulated), count cache hits/misses since last sample, and
        // dump every 60 frames. _alphaChanged tally helps (B).
        private int _lightDiagFrameIdx;
        private int _lightDiagCacheHits;
        private int _lightDiagCacheMisses;
        private int _lightDiagCountMin = int.MaxValue;
        private int _lightDiagCountMax = int.MinValue;
        private long _lightDiagCountSum;
        private int _lightDiagAlphaChangedFrames;
        // Per-path counters: pathA = AddLight calls during the chunk
        // loop (cache miss only). pathB = AddLight calls during
        // DrawRenderLists (every frame). Sum of both per frame is sampled
        // when we wrap to a new frame at PrepareLightsRendering top.
        private int _lightDiagPathACountThisFrame;
        private int _lightDiagPathBCountThisFrame;
        private int _lightDiagPathAMin = int.MaxValue;
        private int _lightDiagPathAMax = int.MinValue;
        private int _lightDiagPathBMin = int.MaxValue;
        private int _lightDiagPathBMax = int.MinValue;
        private bool _lightDiagInChunkLoop;
#endif
        private Item _multi;
        private Rectangle _rectangleObj = Rectangle.Empty,
            _rectanglePlayer;
        private long _timePing;

        private uint _timeToPlaceMultiInHouseCustomization;
        private readonly UseItemQueue _useItemQueue;
        private bool _useObjectHandles;
        private AnimatedStaticsManager _animatedStaticsManager;

        private readonly World _world;

        // Track the previously highlighted mesh sprite so we can restore its hue
        private GameObject _prevMeshHighlight;

        public GameScene(World world)
        {
            _world = world;
            _useItemQueue = new UseItemQueue(world);
        }

        public bool UpdateDrawPosition { get; set; }
        public bool DisconnectionRequested { get; set; }
        public bool UseLights =>
            ProfileManager.CurrentProfile != null
            && ProfileManager.CurrentProfile.UseCustomLightLevel
                ? _world.Light.Personal < _world.Light.Overall
                : _world.Light.RealPersonal < _world.Light.RealOverall;
        public bool UseAltLights =>
            ProfileManager.CurrentProfile != null
            && ProfileManager.CurrentProfile.UseAlternativeLights;

        public void DoubleClickDelayed(uint serial)
        {
            _useItemQueue.Add(serial);
        }

        public override void Load()
        {
            base.Load();

            Client.Game.Window.AllowUserResizing = true;

            Camera.Zoom = ProfileManager.CurrentProfile.DefaultScale;
            Camera.Bounds.X = Math.Max(0, ProfileManager.CurrentProfile.GameWindowPosition.X);
            Camera.Bounds.Y = Math.Max(0, ProfileManager.CurrentProfile.GameWindowPosition.Y);
            Camera.Bounds.Width = Math.Max(0, ProfileManager.CurrentProfile.GameWindowSize.X);
            Camera.Bounds.Height = Math.Max(0, ProfileManager.CurrentProfile.GameWindowSize.Y);

            Client.Game.UO.GameCursor.ItemHold.Clear();

            _world.Macros.Clear();
            _world.Macros.Load();
            _animatedStaticsManager = new AnimatedStaticsManager();
            _animatedStaticsManager.Initialize();
            _world.InfoBars.Load();
            _healthLinesManager = new HealthLinesManager(_world);

            _world.CommandManager.Initialize();

            WorldViewportGump viewport = new WorldViewportGump(_world, this);
            UIManager.Add(viewport, false);

            if (!ProfileManager.CurrentProfile.TopbarGumpIsDisabled)
            {
                TopBarGump.Create(_world);
            }

            NetClient.Socket.Disconnected += SocketOnDisconnected;
            _world.MessageManager.MessageReceived += ChatOnMessageReceived;
            UIManager.ContainerScale = ProfileManager.CurrentProfile.ContainersScale / 100f;
            Data.MovementSpeed.FastRotation = ProfileManager.CurrentProfile.FastRotation;

            SDL.SDL_SetWindowMinimumSize(Client.Game.Window.Handle, Client.Game.ScaleWithDpi(640), Client.Game.ScaleWithDpi(480));

            if (ProfileManager.CurrentProfile.WindowBorderless)
            {
                Client.Game.SetWindowBorderless(true);
            }
            else if (Settings.GlobalSettings.IsWindowMaximized)
            {
                Client.Game.MaximizeWindow();
            }
            else if (Settings.GlobalSettings.WindowSize.HasValue)
            {
                int w = Settings.GlobalSettings.WindowSize.Value.X;
                int h = Settings.GlobalSettings.WindowSize.Value.Y;

                w = Math.Max(Client.Game.ScaleWithDpi(640), w);
                h = Math.Max(Client.Game.ScaleWithDpi(480), h);

                Client.Game.SetWindowSize(w, h);
            }

            Plugin.OnConnected();
        }

        private void ChatOnMessageReceived(object sender, MessageEventArgs e)
        {
            if (e.Type == MessageType.Command)
            {
                return;
            }

            string name;
            string text;

            ushort hue = e.Hue;

            switch (e.Type)
            {
                case MessageType.Regular:
                case MessageType.Limit3Spell:

                    if (e.Parent == null || !SerialHelper.IsValid(e.Parent.Serial))
                    {
                        name = ResGeneral.System;
                    }
                    else
                    {
                        name = e.Name;
                    }

                    text = e.Text;

                    break;

                case MessageType.System:
                case MessageType.GmChat:
                    name =
                        string.IsNullOrEmpty(e.Name)
                        || string.Equals(
                            e.Name,
                            "system",
                            StringComparison.InvariantCultureIgnoreCase
                        )
                            ? ResGeneral.System
                            : e.Name;

                    text = e.Text;

                    break;

                case MessageType.Emote:
                    name = e.Name;
                    text = $"{e.Text}";

                    if (e.Hue == 0)
                    {
                        hue = ProfileManager.CurrentProfile.EmoteHue;
                    }

                    break;

                case MessageType.Label:

                    if (e.Parent == null || !SerialHelper.IsValid(e.Parent.Serial))
                    {
                        name = string.Empty;
                    }
                    else if (string.IsNullOrEmpty(e.Name))
                    {
                        name = ResGeneral.YouSee;
                    }
                    else
                    {
                        name = e.Name;
                    }

                    text = e.Text;

                    break;

                case MessageType.Spell:
                    name = e.Name;
                    text = e.Text;

                    break;

                case MessageType.Party:
                    text = e.Text;
                    name = string.Format(ResGeneral.Party0, e.Name);
                    hue = ProfileManager.CurrentProfile.PartyMessageHue;

                    break;

                case MessageType.Alliance:
                    text = e.Text;
                    name = string.Format(ResGeneral.Alliance0, e.Name);
                    hue = ProfileManager.CurrentProfile.AllyMessageHue;

                    break;

                case MessageType.Guild:
                    text = e.Text;
                    name = string.Format(ResGeneral.Guild0, e.Name);
                    hue = ProfileManager.CurrentProfile.GuildMessageHue;

                    break;

                default:
                    text = e.Text;
                    name = e.Name;
                    hue = e.Hue;

                    Log.Warn($"Unhandled text type {e.Type}  -  text: '{e.Text}'");

                    break;
            }

            if (!string.IsNullOrEmpty(text))
            {
                _world.Journal.Add(text, hue, name, e.Parent?.Serial, e.TextType, e.IsUnicode, e.Type);
            }
        }

        public override void Unload()
        {
            if (IsDestroyed)
            {
                return;
            }

            ProfileManager.CurrentProfile.GameWindowPosition = new Point(
                Camera.Bounds.X,
                Camera.Bounds.Y
            );
            ProfileManager.CurrentProfile.GameWindowSize = new Point(
                Camera.Bounds.Width,
                Camera.Bounds.Height
            );
            ProfileManager.CurrentProfile.DefaultScale = Camera.Zoom;

            Client.Game.Audio?.StopMusic();
            Client.Game.Audio?.StopSounds();

            Client.Game.SetWindowTitle(string.Empty);
            Client.Game.UO.GameCursor.ItemHold.Clear();

            try
            {
                Plugin.OnDisconnected();
            }
            catch { }

            _world.TargetManager.Reset();

            // special case for wmap. this allow us to save settings
            UIManager.GetGump<WorldMapGump>()?.SaveSettings();

            ProfileManager.CurrentProfile?.Save(_world, ProfileManager.ProfilePath);

            _world.Macros.Save();
            _world.Macros.Clear();
            _world.InfoBars.Save();
            ProfileManager.UnLoadProfile();
            // Bug O2: logout path writes profile + macros + infobars.
            // On wasm tab-close rarely invokes Unload — but when it
            // IS reached (clean logout via main menu), flush so the
            // user's final state persists immediately rather than
            // waiting for the next auto-save-tick that may never
            // come before the process dies.
            GameController.FlushIdbfs();

            StaticFilters.CleanCaveTextures();
            StaticFilters.CleanTreeTextures();

            NetClient.Socket.Disconnected -= SocketOnDisconnected;
            NetClient.Socket.Disconnect();

            _world.CommandManager.UnRegisterAll();
            _world.Weather.Reset();
            UIManager.Clear();
            _world.Clear();
            _world.ChatManager.Clear();
            _world.DelayedObjectClickManager.Clear();

            _useItemQueue?.Clear();
            _world.MessageManager.MessageReceived -= ChatOnMessageReceived;

            Settings.GlobalSettings.WindowSize = new Point(
                Client.Game.ClientBounds.Width,
                Client.Game.ClientBounds.Height
            );

            Settings.GlobalSettings.IsWindowMaximized = Client.Game.IsWindowMaximized();
            Client.Game.SetWindowBorderless(false);

            base.Unload();
        }

        private void SocketOnDisconnected(object sender, SocketError e)
        {
            if (Settings.GlobalSettings.Reconnect)
            {
                _forceStopScene = true;
            }
            else
            {
                UIManager.Add(
                    new MessageBoxGump(
                        _world,
                        200,
                        200,
                        string.Format(
                            ResGeneral.ConnectionLost0,
                            StringHelper.AddSpaceBeforeCapital(e.ToString())
                        ),
                        s =>
                        {
                            if (s)
                            {
                                Client.Game.SetScene(new LoginScene(_world));
                            }
                        }
                    )
                );
            }
        }

        public void RequestQuitGame()
        {
            UIManager.Add(
                new QuestionGump(
                    _world,
                    ResGeneral.QuitPrompt,
                    s =>
                    {
                        if (s)
                        {
                            if (
                                (
                                    _world.ClientFeatures.Flags
                                    & CharacterListFlags.CLF_OWERWRITE_CONFIGURATION_BUTTON
                                ) != 0
                            )
                            {
                                DisconnectionRequested = true;
                                NetClient.Socket.Send_LogoutNotification();
                            }
                            else
                            {
                                NetClient.Socket.Disconnect();
                                Client.Game.SetScene(new LoginScene(_world));
                            }
                        }
                    }
                )
            );
        }

        public void AddLight(GameObject obj, GameObject lightObject, int x, int y)
        {
            if (
                _lightCount >= LightsLoader.MAX_LIGHTS_DATA_INDEX_COUNT
                || !UseLights && !UseAltLights
                || obj == null
            )
            {
                return;
            }

            bool canBeAdded = true;

            int testX = obj.X + 1;
            int testY = obj.Y + 1;

            GameObject tile = _world.Map.GetTile(testX, testY);

            if (tile != null)
            {
                sbyte z5 = (sbyte)(obj.Z + 5);

                for (GameObject o = tile; o != null; o = o.TNext)
                {
                    if (
                        (!(o is Static s) || s.ItemData.IsTransparent)
                            && (!(o is Multi m) || m.ItemData.IsTransparent)
                        || !o.AllowedToDraw
                    )
                    {
                        continue;
                    }

                    if (o.Z < _maxZ && o.Z >= z5)
                    {
                        canBeAdded = false;

                        break;
                    }
                }
            }

            if (canBeAdded)
            {
                ref LightData light = ref _lights[_lightCount];

                ushort graphic = lightObject.Graphic;

                if (
                    graphic >= 0x3E02 && graphic <= 0x3E0B
                    || graphic >= 0x3914 && graphic <= 0x3929
                    || graphic == 0x0B1D
                )
                {
                    light.ID = 2;
                }
                else
                {
                    if (obj == lightObject && obj is Item item)
                    {
                        light.ID = item.LightID;
                    }
                    else if (lightObject is Item it)
                    {
                        light.ID = (byte)it.ItemData.LightIndex;

                        if (obj is Mobile mob)
                        {
                            switch (mob.Direction)
                            {
                                case Direction.Right:
                                    y += 33;
                                    x += 22;

                                    break;

                                case Direction.Left:
                                    y += 33;
                                    x -= 22;

                                    break;

                                case Direction.East:
                                    x += 22;
                                    y += 55;

                                    break;

                                case Direction.Down:
                                    y += 55;

                                    break;

                                case Direction.South:
                                    x -= 22;
                                    y += 55;

                                    break;
                            }
                        }
                    }
                    else if (obj is Mobile _)
                    {
                        light.ID = 1;
                    }
                    else
                    {
                        ref StaticTiles data = ref Client.Game.UO.FileManager.TileData.StaticData[obj.Graphic];
                        light.ID = data.Layer;
                    }
                }

                light.Color = 0;
                light.IsHue = false;

                if (ProfileManager.CurrentProfile.UseColoredLights)
                {
                    if (light.ID > 200)
                    {
                        light.Color = (ushort)(light.ID - 200);
                        light.ID = 1;
                    }

                    if (LightColors.GetHue(graphic, out ushort color, out bool ishue))
                    {
                        light.Color = color;
                        light.IsHue = ishue;
                    }
                }

                if (light.ID >= LightsLoader.MAX_LIGHTS_DATA_INDEX_COUNT)
                {
                    return;
                }

                if (light.Color != 0)
                {
                    light.Color++;
                }

                light.DrawX = x;
                light.DrawY = y;
                _lightCount++;
#if BROWSER_WASM
                // v0.4.11 lights-diag: which path are we coming from?
                if (_lightDiagInChunkLoop) _lightDiagPathACountThisFrame++;
                else _lightDiagPathBCountThisFrame++;

                // v0.4.52: record this Path A light into the current chunk's
                // cache so the v0.4.51 cache-replay path can re-call AddLight
                // for it on the next stable+clean cache-MISS. Without this,
                // torches/lanterns/static lights vanish on every replay frame
                // (Path A drops to zero) and reappear on the next full-
                // iteration frame — the classic "fluorescent flicker"
                // operator caught in runmatch7.log. Gate excludes Path B
                // (DrawRenderLists adds those every frame regardless) and
                // the replay loop itself (avoid self-duplication).
                if (_lightDiagInChunkLoop
                    && !_inChunkCacheReplay
                    && _currentChunkForRecord != null)
                {
                    _currentChunkForRecord.CachedLightObjects.Add(obj);
                }
#endif
            }
        }

#if BROWSER_WASM
        // v0.3.47 idle-skip cache. Re-introduction of v0.3.39's cache after
        // the v0.3.46 full revert (the v0.3.39 implementation had a visual
        // regression — "horizonte negro" — caused by an incomplete cache
        // key that omitted the chunk grid bounds). This rev's key includes
        // _minTile.X/Y AND _maxTile.X/Y so any viewport-bounds change
        // (LoginScene → GameScene resize, browser window resize, zoom
        // change that affects the tile range) invalidates the cache and
        // forces a full chunk-loop pass with the new bounds.
        //
        // The `[fill-cache]` diag below logs every cache miss (rate-limited
        // to 1/sec). When it fires, it includes the tile/chunk grid bounds
        // so a regression on bounds tracking is visible in the dev console
        // immediately, rather than waiting for an operator to notice
        // a black horizon.
        private int _cachedFillX = int.MinValue;
        private int _cachedFillY;
        private sbyte _cachedFillZ;
        private int _cachedFillOffX, _cachedFillOffY;
        private int _cachedMouseX, _cachedMouseY;
        private bool _cachedFillUseHandles;
        private float _cachedFillZoom = -1f;
        private int _cachedFillMinTileX, _cachedFillMinTileY;
        private int _cachedFillMaxTileX, _cachedFillMaxTileY;
        // 2026-09-15 (ported from the mini): the PIXEL box the last fill clipped against. The tile box above
        // can stay the same while the pixel box moves, so the idle skip keys on this too.
        private Vector2 _cachedFillMinPixel, _cachedFillMaxPixel;
        private Point _visibleWorldMin, _visibleWorldMax;

        /// <summary>
        /// Is everything a player can SEE right now inside the box this chunk's replay cache was clipped
        /// under? Only then is replaying it complete.
        /// </summary>
        /// <remarks>
        /// Found on the mini (operator 2026-09-14, a folding phone: parts of the board undrawn "hasta que
        /// vuelves a cambiar el aspect ratio") and ported because this client has the same gate. The cache
        /// holds only what passed the pixel clip of the fill that built it, and the replay gate asked only
        /// whether the PLAYER had moved. Here the view changes without the player moving whenever the
        /// browser window or the game window is resized, or the zoom changes: stable chunks then replayed a
        /// clip that no longer covered the screen.
        ///
        /// CONTAINMENT, NOT "NOTHING CHANGED": the draw offset moves every frame while the hero walks between
        /// tiles, so refusing replay on any change would cost a full chunk walk on every walking frame. An
        /// object was cached iff its screen position lay in [clipMin + offsetThen, clipMax + offsetThen], and
        /// matters now iff it lies in [visMin + offsetNow, visMax + offsetNow]; replay is allowed while the
        /// second range sits inside the first with KEEP px of the old off-screen margin to spare.
        /// KEEP is a trade: that margin is sprite overhang a moving view can show unfilled at its leading
        /// edge. It must stay under the margin itself, (int)(44 / zoom) screen px, or every replay is refused.
        /// </remarks>
        private bool ReplayClipCovers(Chunk c)
        {
            const float KEEP = 32f; // world px of the old off-screen margin a replay must still have
            if (c.CachedClipZoom != Camera.Zoom) return false;
            // The circle of transparency and the foliage fade were computed around the hero's screen position
            // at cache time; a replay would keep them there while the hero's walk offset slides the view.
            if (ProfileManager.CurrentProfile.UseCircleOfTransparency
                && (_offset.X != c.CachedClipOffX || _offset.Y != c.CachedClipOffY)) return false;
            return _visibleWorldMin.X + _offset.X - KEEP >= c.CachedClipMinX + c.CachedClipOffX
                && _visibleWorldMax.X + _offset.X + KEEP <= c.CachedClipMaxX + c.CachedClipOffX
                && _visibleWorldMin.Y + _offset.Y - KEEP >= c.CachedClipMinY + c.CachedClipOffY
                && _visibleWorldMax.Y + _offset.Y + KEEP <= c.CachedClipMaxY + c.CachedClipOffY;
        }
        private long _fillCacheLastLog;

#if BROWSER_WASM
        // v0.4.51: per-chunk slow-path replay cache wiring. Set by the
        // chunk loop right before invoking AddTileToRenderList so that
        // PushToRenderQueue + the mesh fast-path can record their per-
        // object contributions into the chunk's cache lists for next-
        // frame replay. See Chunk.CachedContribs.
        private Chunk _currentChunkForRecord;
        // v0.4.52: set true during the cache-replay path so AddLight
        // does NOT record into the cache (we're already iterating it).
        // Without this guard, replay's AddLight calls would duplicate
        // the chunk's CachedLightObjects entries each cache-MISS frame
        // until the chunk's cache invalidates.
        private bool _inChunkCacheReplay;
#endif

        // v0.4.47 (supersedes v0.4.44): cache the resolved non-Mobile
        // SelectedObject.Object from the last cache-MISS fill so cache-HIT
        // frames can restore it WITHOUT iterating the 5 _renderLists
        // (Transparents, Animations, Statics, StretchedTiles, Tiles).
        //
        // Why this is safe: the cache key for FillGameObjectList already
        // requires mouse + player + offset + tile bounds + zoom to be
        // unchanged. Non-Mobile sprites (Land, Static, Item, GameEffect,
        // ...) have deterministic CheckMouseSelection results given those
        // invariants — same pixel under cursor, same hit/miss outcome.
        // Re-iterating them on every cache-hit frame is pure repeated work.
        //
        // Mobiles are excluded from the cache because they anim-tick
        // (sprite frame index advances independently of player/mouse
        // motion), so a Mobile cached on frame N may have shifted its
        // bbox/pixel-mask by frame N+1. The cache-hit refresh still
        // iterates _renderLists.Animations + runs TryRescueMobileSelection
        // ViaBbox so a newly-revealed Mobile (anim shift) still wins via
        // depth-Z tiebreak.
        //
        // Performance impact (operator data 2026-05-11 runmatch logs):
        // Z=100 arena fill-sub dropped from 130-168 ms steady-state to
        // <10 ms because the 5-list × hundreds-of-items × CheckMouse-
        // Selection scan collapsed to 1 list × small Mobile count.
        //
        // Supersedes v0.4.44 _cachedMeshSelection (meshed Land/Static
        // only) — those cases are subsumed since Land + Static are
        // both non-Mobile and now part of the broader cache.
        private GameObject _cachedNonMobileSelection;

        // v0.4.0 chunk-diff instrumentation. Foundation for the
        // running-smoothness refactor. Tracks which chunks were
        // visible in the previous fill so we can measure how many
        // chunks actually stay across tile-steps (= upper bound
        // for the differential-update cache savings the v0.4.x
        // track is targeting). Pure instrumentation in v0.4.0 —
        // NO behavioural change, only a `[chunks-diff]` log line
        // per fill (rate-limited 1/sec).
        private readonly HashSet<Map.Chunk> _prevVisibleChunkSet = new();
        private readonly HashSet<Map.Chunk> _curVisibleChunkSet = new();
        // v0.8.89 statics-catchup instrumentation state (see catchup block).
        private static bool _staticsCatchupBannerShown;
        private static long _lastCatchupLogMs;
        private static long _lastSnapHydrated;
        private long _chunksDiffLastLog;

        // v0.4.1 fill-sub log throttle.
        private long _fillSubLastLog;

        // v0.4.4 per-fill mesh.Build budget. Reset at each cache-miss fill.
        // Bounds the per-frame cost of building newly-pooled chunks so
        // running hitches drop from ~27 ms (9 builds in one frame) to
        // ~6 ms (2 builds per frame, rest deferred to next fills).
        //
        // v0.4.48: raised 2 → 4. v0.4.46's asymmetric Z-pad widened the
        // visible chunk count at high |Z| (49 → 64 chunks at Z=100 per
        // operator runmatch3.log) and v0.4.47's cache-HIT optimization
        // dropped fill-sub from 130-168 ms to 0 ms on hit. Net: cache-MISS
        // fills (tile-cross only, ~5/sec at run speed) can absorb 2× the
        // build work without breaching the 16 ms frame budget. 4 builds ×
        // 3-5 ms = 12-20 ms per cache-miss fill; cache-HIT frames cost
        // 0 ms. Closes the "blank leading-edge while running upward at
        // high Z" reported by operator on v0.4.47 (runmatch3.log lDef
        // peaked at 36, builds-deferred similar pattern).
        private const int FILL_BUILD_BUDGET = 4;
        private int _fillBuildBudget;
        private int _fillBuildsDeferredThisFill;

        // v0.4.59: Z-distance LOD streaming. Far-Z chunks (|chunk.MaxContentZ -
        // playerZ| > Z_LOD_BAND) have their own per-fill budget so they
        // stream in gradually instead of competing with near-Z chunks for
        // the main FILL_BUILD_BUDGET. Set in the chunk-loop pre-amble.
        private int _fillFarZBuildBudget;
        private const int Z_LOD_BAND = 30;

        // v0.4.8: dynamic chunk.Load budget.
        // v0.4.6 set 2 (good baseline), v0.4.7 dropped to 1 (kills hitches
        // but creates visible "seams" when running — chunks at the leading
        // diamond edge stay blank for 6+ frames as 7 fresh chunks per
        // tile-step trickle in 1/frame). Operator real-test confirmed seam
        // visibility + slow post-teleport map fill (lDef=43-67 = ~1 second
        // before the area visually populates).
        //
        // v0.4.8 splits the budget into:
        //  - FILL_LOAD_BUDGET_NORMAL: steady-state per-fill cap (2). Keeps
        //    chunk loop ≤8ms typical. 7 chunks per tile-step catch up in
        //    ~4 fills (~64ms) — barely visible at the diamond's far edge.
        //  - FILL_LOAD_BUDGET_BURST: triggered when the visible viewport
        //    has a large unloaded backlog (post-teleport). Loads 4-5 chunks
        //    per fill until the backlog drops below the burst threshold.
        //    Cost: ~12-15ms per burst frame, but burst lasts <10 fills total
        //    (~150ms blip vs. ~1 second of empty map).
        // v0.4.48: raised NORMAL 2 → 4 and BURST 5 → 8 to absorb the
        // wider viewport from v0.4.46 (Z=100 covers 64 chunks vs 49 at
        // ground level → ~8 new chunks per tile-step on the lifted side
        // when running). Operator runmatch3.log: lDef peaked at 36 with
        // the v0.4.47 settings, confirming BURST=5 chronically under-
        // provisioned at high Z. New BURST=8 matches the worst-case new-
        // chunks-per-tile-step exactly. Cache-HIT frames (v0.4.47) cost
        // 0 ms so the extra ~5-10 ms per cache-miss is in-budget at 60 FPS.
        private const int FILL_LOAD_BUDGET_NORMAL = 4;
        // v0.4.86: REVERTED v0.4.85 BURST raise (20 -> 8). The 20-load
        // burst regressed maxStuckRun from 1500 ms (v0.4.84) to 8000 ms
        // — the bot captured 32 consecutive 250 ms samples with identical
        // fingerprint. Hypothesis: chunk.Load under IDBFS + Mercury MT
        // deputy is much costlier than the v0.4.14 ~3-5 ms desktop figure;
        // 20 fresh loads per fill blocked the deputy worker for hundreds
        // of ms, preventing it from shipping new frames to WebGL. Reverting
        // to the v0.4.14 + v0.4.48 settings: NORMAL=4, BURST=8. The
        // residual ~1.5 s entry-partial-black is preferred over an 8 s
        // full freeze.
        private const int FILL_LOAD_BUDGET_BURST = 8;
        private const int FILL_LOAD_BURST_THRESHOLD = 15;
        private int _fillLoadBudget;
        private int _fillLoadsDeferredThisFill;
        // v0.4.8: lDef from PREVIOUS fill — used to decide if next fill
        // should burst (high lDef = backlog of unloaded chunks visible).
        private int _fillLoadsDeferredLastFill;

        // v0.4.9: teleport detection. When the player jumps more than this
        // many tiles between consecutive fills it's a teleport ([go, gate,
        // recall, server-pushed warp). Walking + running max 1 tile/fill,
        // so a delta >5 is unambiguous.
        //
        // v0.4.13: replaced the v0.4.9 single-frame "int.MaxValue" bypass
        // (which produced one ~270-330 ms hitch logged as Draw.FillObj=271)
        // with a 3-fill burst at FILL_TELEPORT_BUDGET each.
        // v0.4.14: real-test 2026-05-08 showed BUDGET=20 produces 130-200 ms
        // long-frames (chunk.Load is ~3-5 ms per chunk under sphere load,
        // higher than my ~3 ms estimate). Lowered to 12 + bumped fills to 5
        // so 56 chunks / 12 = 5 fills, each ~50-80 ms instead of 130-200.
        // Total drain time grows slightly (~5×16 + 5×60 = ~380 ms wallclock,
        // vs ~330 ms with the v0.4.13 setting) but no single frame feels
        // like a freeze — that's the perceptual win.
        private const int FILL_TELEPORT_THRESHOLD_TILES = 5;
        private const int FILL_TELEPORT_BUDGET = 12;
        private const int FILL_TELEPORT_BURST_FILLS = 5;
        private int _fillTeleportRemainingFills;

        // v0.5.19 strategy #1: time-slicing wall-clock cap. The existing
        // count-based FILL_TELEPORT_BUDGET=12/fill + unbounded
        // `forceBuildForBurst` (line 1600 of the chunk loop) allowed a single
        // fill to process 49 dirty chunks when an unfamiliar facet/zone
        // arrived (`[runmatch 1` etc.) — bot measured 40 % of teleports with
        // a 4–5 s freeze (`bot-britain-runmatch-walk`, 2026-05-22, p95=4868
        // ms, max=5328 ms). The Mesh.Build comment claimed "0 ms" but that
        // measurement was only the warm-tiledata fast path; on cold zones
        // each chunk's Build runs ~80–100 ms (tiledata fetch + Static object
        // creation + texture-bucket counting + GPU upload). 49 × 100 ms = 4.9 s.
        //
        // The fix is a hard wall-clock cap on the per-fill mesh.Build time:
        //   - Steady state: 8 ms (half a vsync slice).
        //   - Burst:        16 ms (full vsync slice; we want progress but not
        //                          at the cost of a frozen frame).
        // When the cap is reached, dirty chunks defer to subsequent fills.
        // To avoid a never-ending defer loop we auto-extend the burst by one
        // fill whenever the previous burst fill deferred any builds — so the
        // 5-fill default is the minimum, not the maximum, when the work is
        // genuinely heavy. Total wall-clock is the same (49 × 100 ms ≈ 4.9 s
        // either way) but spread across N×16 ms slices instead of one giant
        // freeze, leaving input and rendering responsive throughout.
        // v0.6.2 Fix 7: push the v0.5.19 caps lower (8→4 steady, 16→8 burst).
        // Hypothesis: 8 ms is already half a 60 Hz vsync slice; halving again
        // (4 ms) keeps any single fill below a quarter-vsync so the frame
        // window stays consistently smooth. Burst goes to 8 ms — still a full
        // vsync but with the cap-reached deferral kicking in earlier, so
        // teleport-burst fills spread across more frames (~10 fills × 8 ms
        // instead of ~5 fills × 16 ms). Risk: visibly more "blank tiles at the
        // leading edge for one extra frame" while the burst drains.
        // Rollback if smoke regresses or operator reports visible seams.
        private const long FILL_BUILD_TIME_BUDGET_MS = 4;
        private const long FILL_TELEPORT_TIME_BUDGET_MS = 8;
        private const int FILL_TELEPORT_BURST_FILLS_MAX = 32; // safety cap
        private long _fillBuildElapsedMs;
        private long _fillBuildTimeBudgetMs;
        // v0.4.71-diag: one-shot flag — when set, log per-chunk Mesh.Land.Count
        // + Mesh.Statics.Count post-Build for the FIRST fill of a teleport
        // burst. Clears after that one fill. Lets us see if any new chunk
        // built with empty mesh (fresh-loaded + statics-pending) which would
        // render as a black tile-block at the viewport edge.
        // v0.4.76-diag: extended to fire on ALL 5 burst fills (operator
        // confirmed manual [tele 3-6 tile teleports reproduce post-tele
        // black region whereas server-side MoveToWorld via [teleburst does
        // not — narrows the suspect window to one of fills 2-5 which the
        // previous one-shot dump missed). Burst-fill counter prefixed to
        // each log line so operator can map per-fill state.
        private bool _teleDiagDumpChunks;
        // Burst-fill index (1..FILL_TELEPORT_BURST_FILLS); 0 = not in burst.
        // Logged into each [tele-land-stats] + [tele-chunk] line.
        private int _teleDiagBurstFillIdx;
        // v0.8.94: the [tele-*] dump (~300 Console.WriteLine per teleport ×
        // 5 burst fills) ran UNCONDITIONALLY for every player since the
        // v0.4.7x black-region hunt — string interpolation + JS-boundary
        // marshalling paid even with the console silenced, exactly during
        // the most perf-sensitive moment. Now armed only when main.js sets
        // CUO_TELE_DIAG=1 (URL param ?teleDiag=1). Default: silent.
        private static readonly bool _teleDiagEnabled =
            System.Environment.GetEnvironmentVariable("CUO_TELE_DIAG") == "1";

        // v0.4.75-diag: per-chunk Land iteration counters for the FIRST fill
        // of a teleport burst. AddTileToRenderList writes these when
        // _teleDiagDumpChunks is true; the chunk loop emits a one-line
        // [tele-land-stats] summary per chunk so we can tell which chunks
        // (NE / NW / SW / SE) have tiles getting clipped vs SetVisible'd vs
        // hitting AlphaHue==0 vs missing their mesh sprite index. This is
        // the data needed to identify why post-teleport black persists with
        // the v0.4.74 AlphaHue promotion in place.
        internal int _diagLandIter;         // total Lands that entered AddTileToRenderList for this chunk
        internal int _diagLandClipX;        // broke out of linked-list iteration due to screenX clip
        internal int _diagLandClipY;        // skipped due to screenY clip
        internal int _diagLandMaxZ;         // skipped due to maxObjectZ > maxZ
        internal int _diagLandAlphaPromoted;// hit the v0.4.74 AlphaHue==0 → 0xFF promotion
        internal int _diagLandSetVis;       // SetVisible() actually called
        internal int _diagLandSpriteMissing;// MeshSpriteIndex < 0 (never built into mesh)
#endif

        private void FillGameObjectList()
        {
#if BROWSER_WASM
            // v0.4.1 sub-stage instrumentation. v0.4.0 chunks-diff revealed
            // that the chunk loop runs in ~0-1ms while Draw.FillObj total
            // is 35-50ms. The bottleneck is OUTSIDE the chunk loop. v0.4.1
            // wraps each major section so we can pinpoint the actual hot
            // path before designing v0.4.2's optimisation.
            //
            // Sub-stages measured:
            //  - gvpMs    : GetViewPort + UpdateMaxDrawZ (top of method)
            //  - chunkMs  : chunk loop (already in v0.4.0 chunks-diff)
            //  - foliMs   : foliage alpha update
            //  - textMobMs: UpdateTextServerEntities for Mobiles
            //  - textItmMs: UpdateTextServerEntities for Items
            //
            // Output: extends the existing [chunks-diff] line so the data
            // is correlated. Rate-limited to 1/sec.
            var fillSubSw = System.Diagnostics.Stopwatch.StartNew();
            long fillSubGvpMs = 0;
            long fillSubFoliMs = 0;
            long fillSubTextMobMs = 0;
            long fillSubTextItmMs = 0;
#endif

            _foliageCount = 0;

            if (!_world.InGame)
            {
                _renderLists.Clear();
                _visibleChunks.Clear();
                return;
            }

            _alphaChanged = _alphaTimer < Time.Ticks;

            if (_alphaChanged)
            {
                _alphaTimer = Time.Ticks + Constants.ALPHA_TIME;
            }

            if (ProfileManager.CurrentProfile.UseCircleOfTransparency)
            {
                float r = ProfileManager.CurrentProfile.CircleOfTransparencyRadius;
                _cotRadiusSq = r * r;
                _cotPlayerScreenPos = _world.Player.GetScreenPosition();
                _cotGradientMode = ProfileManager.CurrentProfile.CircleOfTransparencyType == 1;
            }
            else
            {
                _cotRadiusSq = 0;
                _cotGradientMode = false;
            }

            FoliageIndex++;

            if (FoliageIndex >= 100)
            {
                FoliageIndex = 1;
            }

#if BROWSER_WASM
            var gvpSw = System.Diagnostics.Stopwatch.StartNew();
#endif
            GetViewPort();
#if BROWSER_WASM
            fillSubGvpMs = gvpSw.ElapsedMilliseconds;
#endif

            var ctrlShiftHeld = Keyboard.Ctrl && Keyboard.Shift;
            var useObjectHandles = _world.NameOverHeadManager.IsToggled || ctrlShiftHeld;
            if (useObjectHandles != _useObjectHandles)
            {
                _useObjectHandles = useObjectHandles;
                if (_useObjectHandles)
                {
                    _world.NameOverHeadManager.Open();
                    if (_world.NameOverHeadManager.IsToggled && !ctrlShiftHeld)
                    {
                        _world.NameOverHeadManager.SetMenuVisible(false);
                    }
                }
                else
                {
                    _world.NameOverHeadManager.Close();
                }
            }
            else if (_useObjectHandles && _world.NameOverHeadManager.IsToggled)
            {
                _world.NameOverHeadManager.SetMenuVisible(ctrlShiftHeld);
            }

            _rectanglePlayer.X = (int)(
                _world.Player.RealScreenPosition.X
                - _world.Player.FrameInfo.X
                + 22
                + _world.Player.Offset.X
            );
            _rectanglePlayer.Y = (int)(
                _world.Player.RealScreenPosition.Y
                - _world.Player.FrameInfo.Y
                + 22
                + (_world.Player.Offset.Y - _world.Player.Offset.Z)
            );
            _rectanglePlayer.Width = _world.Player.FrameInfo.Width;
            _rectanglePlayer.Height = _world.Player.FrameInfo.Height;

            int minX = _minTile.X;
            int minY = _minTile.Y;
            int maxX = _maxTile.X;
            int maxY = _maxTile.Y;
            Map.Map map = _world.Map;
            bool use_handles = _useObjectHandles;
            (var minChunkX, var minChunkY) = (minX >> 3, minY >> 3);
            (var maxChunkX, var maxChunkY) = (maxX >> 3, maxY >> 3);

#if BROWSER_WASM
            // v0.3.47 idle-skip cache check. Cache hits when EVERY input
            // that affects the contents of _renderLists / _visibleChunks /
            // mesh.Visible[] is unchanged since the last full pass:
            //  - player tile position (X/Y/Z)
            //  - rendering offset (_offset.X/Y, derived from camera)
            //  - mouse position (affects hover/selection)
            //  - useObjectHandles toggle
            //  - camera zoom
            //  - tile grid bounds (minTile/maxTile) — added in v0.3.47 to
            //    fix the "horizonte negro" regression from v0.3.39's
            //    incomplete cache key
            //  - alpha-tick not pending (foliage fade boundary)
            //  - UpdateDrawPosition not set (camera lerp drifted past
            //    sub-pixel residual into a real shift)
            // Cache hits short-circuit the full chunk loop AND preserve the
            // existing _renderLists / _visibleChunks / mesh state, so
            // DrawWorld → DrawRenderLists draws the bit-identical content.
            int mouseX = Mouse.Position.X;
            int mouseY = Mouse.Position.Y;
            bool canReuse =
                !_alphaChanged
                && !UpdateDrawPosition
                && _cachedFillX == _world.Player.X
                && _cachedFillY == _world.Player.Y
                && _cachedFillZ == _world.Player.Z
                && _cachedFillOffX == _offset.X
                && _cachedFillOffY == _offset.Y
                && _cachedFillUseHandles == _useObjectHandles
                && _cachedFillZoom == Camera.Zoom
                && _cachedMouseX == mouseX
                && _cachedMouseY == mouseY
                && _cachedFillMinTileX == minX
                && _cachedFillMinTileY == minY
                && _cachedFillMaxTileX == maxX
                && _cachedFillMaxTileY == maxY
                && _cachedFillMinPixel == _minPixel
                && _cachedFillMaxPixel == _maxPixel;
            if (canReuse)
            {
                _lightDiagCacheHits++;
                // v0.4.12: restore _lightCount to the K_static_mesh from
                // the last cache miss BEFORE returning. Path B (in
                // DrawRenderLists, called next from DrawWorld) will then
                // overwrite the previous frame's dynamic-light slots
                // instead of appending. Without this, every consecutive
                // cache hit accumulated K_dyn extra entries pointing at
                // stale-from-prev-frame positions, which PrepareLights-
                // Rendering happily drew as ghost lights. That was the
                // "subset of lights flickers, no clear pattern" symptom.
                _lightCount = _lightCountAfterChunkLoop;

                // v0.4.20.2: re-run hover detection even on cache hit.
                // SelectedObject was reset to null at the start of
                // DrawWorld (line 1638). When the cursor sits still
                // over a Mobile (and the cache hits because mouse pos +
                // player tile + offset are all unchanged), we still
                // need to repopulate SelectedObject so the next
                // [click-recv] sees the correct target. The pass below
                // walks the cached _renderLists (preserved across cache
                // hits) and re-runs CheckMouseSelection / depth-Z
                // tiebreak — same logic PushToRenderQueue does on
                // cache-miss frames. Cheap (~8 mobiles × bbox test) so
                // it does NOT defeat the idle-skip cache; the heavy
                // chunk loop, mesh rebuild and AddLight pass still skip.
                //
                // v0.4.47: restore the cached non-Mobile resolution as the
                // baseline. This subsumes v0.4.44 (which only covered meshed
                // Land/Static) — now ALL non-Mobile sprites (Land, Static,
                // Item, GameEffect, ...) are restored from cache so the
                // refresh doesn't have to iterate Transparents / Statics /
                // StretchedTiles / Tiles. Skip if destroyed (defensive).
                if (_cachedNonMobileSelection != null && !_cachedNonMobileSelection.IsDestroyed)
                {
                    SelectedObject.Object = _cachedNonMobileSelection;
                }
                RefreshSelectedObjectFromCachedRenderLists();
                return;
            }
            _lightDiagCacheMisses++;
            if (_alphaChanged) _lightDiagAlphaChangedFrames++;

            // v0.4.10: reset the per-frame lights collector HERE instead of
            // at the end of DrawLights. Previously the reset lived inside
            // PrepareLightsRendering and ran every frame regardless of
            // whether the fill produced new lights. On cache-hit frames
            // the chunk loop is skipped (return above), AddLight is never
            // called, and _lightCount stayed at 0 because the previous
            // DrawLights cleared it — so DrawLights drew zero lights this
            // frame. Cache miss next frame restored them. That alternation
            // was the "fluorescent flicker" regression from v0.3.39 idle-
            // skip cache.
            _lightCount = 0;

            // Diag: log on cache miss when grid bounds have shifted
            // (catches regressions where bounds drift without the cache
            // catching it). Rate-limited to 1/sec so the dev console
            // stays readable in heavy walking scenarios.
            long fillNowMs = Environment.TickCount64;
            bool boundsChanged =
                _cachedFillMinTileX != minX
                || _cachedFillMinTileY != minY
                || _cachedFillMaxTileX != maxX
                || _cachedFillMaxTileY != maxY;
            if (boundsChanged
                && _cachedFillMinTileX != 0
                && fillNowMs - _fillCacheLastLog >= 1000)
            {
                _fillCacheLastLog = fillNowMs;
                Console.WriteLine($"[fill-bounds] tile=({minX}..{maxX},{minY}..{maxY}) chunk=({minChunkX}..{maxChunkX},{minChunkY}..{maxChunkY}) prev=({_cachedFillMinTileX}..{_cachedFillMaxTileX},{_cachedFillMinTileY}..{_cachedFillMaxTileY})");
            }

            // v0.4.9: detect teleport BEFORE _cachedFillX/Y are overwritten.
            // Compare current player tile vs previous-fill cached tile. Walk
            // + run move max 1 tile/fill so any delta >5 is a teleport.
            // _cachedFillX defaults to int.MinValue (uninitialized first
            // fill) — guard against that.
            // v0.4.13: arm a 3-fill burst window so the budget stays elevated
            // for the two follow-up fills as well (player only moves once
            // but the chunk backlog drains over multiple frames).
            if (_cachedFillX != int.MinValue)
            {
                int teleportDx = System.Math.Abs(_world.Player.X - _cachedFillX);
                int teleportDy = System.Math.Abs(_world.Player.Y - _cachedFillY);
                if (teleportDx > FILL_TELEPORT_THRESHOLD_TILES || teleportDy > FILL_TELEPORT_THRESHOLD_TILES)
                {
                    _fillTeleportRemainingFills = FILL_TELEPORT_BURST_FILLS;
                    Console.WriteLine($"[fill-teleport] dx={teleportDx} dy={teleportDy} — burst {FILL_TELEPORT_BURST_FILLS} fills @ {FILL_TELEPORT_BUDGET}/fill");
                    // v0.4.71-diag: dump viewport bounds + Player.Offset on
                    // teleport entry. If Offset != Vector3.Zero here the
                    // GetViewPort math is shifting the iso diamond off
                    // the iterated tile range (v0.4.68 hypothesis revived).
                    // If _minPixel/_maxPixel don't cover the canvas (970×743),
                    // tiles at the canvas corner go un-rendered = visible
                    // black staircase.
                    if (_teleDiagEnabled)
                    {
                        Console.WriteLine($"[tele-diag] player=({_world.Player.X},{_world.Player.Y},{_world.Player.Z}) offset=({_world.Player.Offset.X},{_world.Player.Offset.Y},{_world.Player.Offset.Z}) tileBox=({_minTile.X}..{_maxTile.X},{_minTile.Y}..{_maxTile.Y}) pixelBox=({_minPixel.X}..{_maxPixel.X},{_minPixel.Y}..{_maxPixel.Y}) drawOffset=({_offset.X},{_offset.Y}) camBounds={Camera.Bounds.Width}x{Camera.Bounds.Height}");
                        _teleDiagDumpChunks = true;
                    }
                }
            }

            // v0.4.79: capture "did player move since last fill?" BEFORE
            // we overwrite _cachedFillX/Y/Z with the current position. Used
            // below to gate cache replay — if the player has moved at all
            // (even 1 tile, below the 5-tile teleport-burst threshold),
            // the per-chunk CachedMeshContribs snapshot is stale because
            // it only contains tiles that PASSED the screenY/X clip at
            // the previous player position. Tiles that were just outside
            // the viewport (clipped → never SetVisible) are now inside,
            // but cache replay doesn't iterate them → Visible[idx] stays
            // at 0 (from ResetVisibility) → BLACK sawtooth wedge at the
            // viewport edges. Bot-confirmed 2026-05-13 at threshold=1
            // (every move triggers burst, bypassing replay) → 0/45 BLACK
            // vs 4/25 BLACK with default threshold=5. Cost: cache stops
            // helping during movement frames (each walk step now full-
            // iterates ~50 visible chunks instead of replaying); cache
            // still helps idle frames and steady-state-camera frames
            // (the v0.4.51 motivating case).
            bool playerMovedSinceLastFill = _cachedFillX != int.MinValue
                && (_world.Player.X != _cachedFillX
                    || _world.Player.Y != _cachedFillY
                    || _world.Player.Z != _cachedFillZ);

            // 2026-09-15: the VISIBLE area this fill must cover, in the same world units as _minPixel /
            // _maxPixel (which add an off-screen margin to it). ReplayClipCovers compares it with the box
            // each chunk's cache was clipped under.
            _visibleWorldMin = Camera.ScreenToWorld(Point.Zero);
            _visibleWorldMax = Camera.ScreenToWorld(new Point(Camera.Bounds.Width, Camera.Bounds.Height));
            _cachedFillMinPixel = _minPixel;
            _cachedFillMaxPixel = _maxPixel;

            _cachedFillX = _world.Player.X;
            _cachedFillY = _world.Player.Y;
            _cachedFillZ = _world.Player.Z;
            _cachedFillOffX = _offset.X;
            _cachedFillOffY = _offset.Y;
            _cachedFillUseHandles = _useObjectHandles;
            _cachedFillZoom = Camera.Zoom;
            _cachedMouseX = mouseX;
            _cachedMouseY = mouseY;
            _cachedFillMinTileX = minX;
            _cachedFillMinTileY = minY;
            _cachedFillMaxTileX = maxX;
            _cachedFillMaxTileY = maxY;
#endif

            _renderLists.Clear();
            _visibleChunks.Clear();

#if BROWSER_WASM
            // v0.4.0 chunk-diff instrumentation: count enter/leave/stable/
            // dirty per fill so we can size the differential-update cache
            // before designing v0.4.1+. Stopwatch around the chunk loop
            // to correlate fillMs with chunk churn.
            _curVisibleChunkSet.Clear();
            int chunksEntered = 0;
            int chunksStable = 0;
            int chunksDirty = 0;
            var chunkSw = System.Diagnostics.Stopwatch.StartNew();
            // v0.5.20 strategy #5: granular profile of the chunk loop. The bot
            // measured fillMs=4390 ms with build=49calls/0 ms in v0.5.19 — the
            // 4.4 s is somewhere INSIDE the chunk loop that isn't Mesh.Build.
            // Break the loop body into sections to find out where.
            // v0.5.23: switch from per-chunk ElapsedMilliseconds (rounded to
            // integer, sub-ms work was reported as 0) to ElapsedTicks
            // accumulator. Sub-ms per chunk × 49 chunks ≈ tens of ms total —
            // visible in TICKS but lost in MS rounding. Convert ticks → ms at
            // the end of the fill via Stopwatch.Frequency.
            long t_getChunk2Ticks = 0;
            long t_meshBuildSectionTicks = 0;
            long t_replayTicks = 0;
            long t_iterateTicks = 0;
            long t_resetLandTicks = 0;
            long t_resetStaticsTicks = 0;
            long t_visBookkeepTicks = 0;
            long t_catchupTicks = 0;
            long t_dirtyCheckTicks = 0;
            int n_getChunk2Calls = 0;
            int n_iteratePathCalls = 0;
            int n_replayPathCalls = 0;
            // v0.4.4: reset the per-fill mesh.Build budget. Chunks beyond
            // budget defer their build to a future fill (rendered as blank
            // for 1-2 frames at running speed; imperceptible).
            // v0.4.13: while inside the post-teleport burst window, use
            // FILL_TELEPORT_BUDGET (20) instead of FILL_BUILD_BUDGET (2).
            // Spreads the ~56 chunks across 3 fills @ ~80-100 ms each,
            // replacing the v0.4.9 single-frame ~270-330 ms hitch.
            bool teleportBurstActive = _fillTeleportRemainingFills > 0;
            // v0.4.76-diag: keep _teleDiagDumpChunks armed for every burst
            // fill so [tele-land-stats] captures fills 2-5 too. burstFillIdx
            // counts from 1 at the first fill of a burst down to BURST_FILLS.
            if (teleportBurstActive)
            {
                // v0.8.94: diag dump only when ?teleDiag=1 — see _teleDiagEnabled.
                _teleDiagDumpChunks = _teleDiagEnabled;
                _teleDiagBurstFillIdx = FILL_TELEPORT_BURST_FILLS - _fillTeleportRemainingFills + 1;
                // v0.4.76-diag: per-fill camera state. drift between
                // fills 1..5 in drawOffset / Camera.Offset / Player.Offset
                // would explain why cached RealScreenPositions become
                // stale and tiles render at wrong screen Y.
                if (_teleDiagEnabled)
                {
                    Console.WriteLine(
                        $"[burst-frame] f{_teleDiagBurstFillIdx} player=({_world.Player.X},{_world.Player.Y},{_world.Player.Z}) " +
                        $"pOff=({_world.Player.Offset.X:F1},{_world.Player.Offset.Y:F1},{_world.Player.Offset.Z:F1}) " +
                        $"drawOff=({_offset.X},{_offset.Y}) " +
                        $"camOff=({Camera.Offset.X:F1},{Camera.Offset.Y:F1}) " +
                        $"updDraw={UpdateDrawPosition}"
                    );
                }
            }
            else
            {
                _teleDiagBurstFillIdx = 0;
            }
            // v0.4.76-diag: force UpdateDrawPosition=true for every burst
            // fill. Pre-v0.4.76 only the FIRST burst fill had this flag
            // (set by the camera-shift detect at GetViewPort tail). Fills
            // 2-5 reused cached RealScreenPosition from fill 1, which is
            // correct as long as _offset doesn't drift between fills. But
            // operator confirmed manual [tele 3-6 tile teleports leave a
            // post-tele black region while server-side MoveToWorld via
            // [teleburst doesn't. Hypothesis: the target-cursor flow
            // around [tele causes Camera.Offset to lerp sub-pixel between
            // burst fills (mouse-move event during target-pick → Camera
            // recenters slightly → _offset drifts) and the cached
            // RealScreenPositions become stale. Force-recomputing every
            // burst fill is cheap (~3500 tile UpdateRealScreenPosition
            // calls per fill, ~1ms total) and safe.
            if (teleportBurstActive)
            {
                UpdateDrawPosition = true;
            }
            _fillBuildBudget = teleportBurstActive ? FILL_TELEPORT_BUDGET : FILL_BUILD_BUDGET;
            _fillBuildsDeferredThisFill = 0;
            // v0.5.19 strategy #1: reset per-fill wall-clock cap.
            _fillBuildElapsedMs = 0;
            _fillBuildTimeBudgetMs = teleportBurstActive ? FILL_TELEPORT_TIME_BUDGET_MS : FILL_BUILD_TIME_BUDGET_MS;
            // v0.4.59: separate budget for far-Z chunks (|chunk.MaxContentZ -
            // playerZ| > Z_LOD_BAND). Smaller than the near-Z budget so
            // far-Z content streams in over multiple fills instead of
            // racing for the same pool — classic LOD/streaming pattern.
            // During a teleport burst we allow up to 4 far-Z builds per
            // fill so the typical ~50 forest chunks at z=0 (player at
            // z=100) drain in ~12 fills (~2 s of gradual fade-in at 100 ms
            // per fill cap). Steady state allows 1 far-Z build per fill —
            // enough to keep up with normal chunk-cross drift without
            // letting a single far-Z chunk monopolise the budget.
            _fillFarZBuildBudget = teleportBurstActive ? 4 : 1;
            // v0.4.8: dynamic load budget — burst when last fill had a
            // large backlog (post-teleport, cross-map jump). The lDef
            // counter from previous fill is the signal.
            // v0.4.13: teleport burst overrides the lDef-based burst —
            // FILL_TELEPORT_BUDGET (20) > FILL_LOAD_BUDGET_BURST (5) so the
            // post-teleport backlog (49+ deferred) drains in 3 fills
            // instead of ~10. Outside the teleport window, lDef-based
            // burst still kicks in for cross-fill drift backlogs.
            _fillLoadBudget = teleportBurstActive
                ? FILL_TELEPORT_BUDGET
                : _fillLoadsDeferredLastFill >= FILL_LOAD_BURST_THRESHOLD
                    ? FILL_LOAD_BUDGET_BURST
                    : FILL_LOAD_BUDGET_NORMAL;
            if (teleportBurstActive)
            {
                _fillTeleportRemainingFills--;
            }
            _fillLoadsDeferredLastFill = _fillLoadsDeferredThisFill;
            _fillLoadsDeferredThisFill = 0;
            // v0.4.11 lights-diag: flag the chunk loop so AddLight knows
            // it's being called from Path A (chunk-mesh static lights)
            // vs Path B (per-object DrawRenderLists, runs every frame).
            _lightDiagInChunkLoop = true;
#endif

#if BROWSER_WASM
            // v0.4.50 time-budget bail-out. Caps the wallclock of a single
            // chunk-loop pass to keep individual frames responsive. When
            // the cap is hit at a chunk boundary, the outer loops break
            // and remaining chunks roll over to the next fill.
            //
            // v0.4.51 fix: switched from Environment.TickCount64 to
            // System.Diagnostics.Stopwatch. Operator runmatch6.log showed
            // the v0.4.50 cap NEVER firing: fill 3 of burst still ran
            // 779ms with chunks-diff total=60 (all 60 chunks visited).
            // Hypothesis: Mono WASM under Mercury MT runtime in the
            // deputy worker may snapshot TickCount64 at Update-tick start
            // and not advance during the synchronous chunk loop, so the
            // delta inside a single tick reads ~0. The existing lag-diag
            // already uses Stopwatch.ElapsedMilliseconds successfully
            // (its events fire at correct ms values), so the same source
            // is reliable here.
            // v0.4.84: raised from 100 -> 250 to absorb item-heavy arena
            // fills (Tower Defense: ~700 items in viewport, cache-replay
            // 130-150 ms typical). At 100 ms the loop bailed on idle frames
            // (player not moving, so the v0.4.83 playerMovedSinceLastFill
            // gate didn't help) -> deferred chunks rendered BLACK. At 250 ms
            // those fills complete naturally -> all chunks render. The bail
            // is still useful as a final safety net for pathological cases
            // (>250 ms = something genuinely wrong, not just dense items).
            const long CHUNK_LOOP_TIME_BUDGET_MS = 250;
            var chunkLoopSw = System.Diagnostics.Stopwatch.StartNew();
            int chunksTimeDeferred = 0;
            bool chunkLoopBailed = false;

            // v0.4.59: Z-distance LOD streaming for fresh-chunk Mesh.Build.
            //
            // CUO's chunk loop has asymmetric Z culling — `_maxZ` clips
            // objects ABOVE the player but no lower bound, so at z=100
            // every chunk in the visible diamond builds down to z=0
            // ground statics. Over dense terrain each chunk Mesh.Build
            // costs ~46 ms (Pass 1+2 over 8×8 tiles × TNext + per-static
            // Arts.GetArt); 50 chunks * 46 ms drains over multiple fills.
            //
            // v0.4.58 binary-culled chunks far below the player. That
            // worked (-12% runmatch sum, britain unaffected) but hid
            // content permanently — gameplay loss at high altitude.
            //
            // v0.4.59 — classic LOD streaming instead. Every chunk
            // EVENTUALLY builds; the question is WHEN. Near-Z chunks
            // (player's altitude band ±30) get the full Build budget and
            // appear in the first fill. Far-Z chunks share a small
            // separate budget — a few per fill — so distant terrain
            // fades in over 1-2 s instead of all at once.
            //
            // Same total work, distributed by Z-distance:
            //   - At z=100 over forest: circuit + altitude band build
            //     immediately; forest at z=0 streams in progressively
            //     across ~5-10 fills.
            //   - At z=0 in britain: most content within ±30, near-Z
            //     budget handles it normally. No regression.
            //   - At z=20 on a roof: ground (z=0, within band) and
            //     nearby tall structures all near-Z, no deferral.
            //
            // The Z_LOD_BAND (30) and far-Z budgets are picked to drain
            // ~50 visible chunks in ~5 fills during a teleport burst.
            int playerZForLod = _world.Player.Z;
            int chunksDeferredFarZ = 0;
#endif
            for (var chunkX = minChunkX; chunkX <= maxChunkX; chunkX++)
            {
                for (var chunkY = minChunkY; chunkY <= maxChunkY; chunkY++)
                {
#if BROWSER_WASM
                    // v0.4.6: cap fresh chunk.Load to FILL_LOAD_BUDGET per
                    // fill. If the chunk isn't already loaded AND budget
                    // is exhausted, skip it this fill (defer to next).
                    //
                    // v0.4.70: during a teleport burst, NEVER skip a chunk
                    // load — the `continue` here was the ROOT CAUSE of the
                    // "cuadrados negros tras [tele corto" report. With a
                    // budget of 12/fill and 13-15 fresh chunks landing in
                    // the viewport at once, the extra 1-3 chunks deferred
                    // rendered as BLACK until a follow-up fill drained them.
                    // The operator's screenshot showed exactly this pattern
                    // (asymmetric black on the side of the new chunks).
                    // The earlier v0.4.68 ClearSteps hypothesis was wrong
                    // (DenyWalk already invokes ClearSteps). During burst
                    // we accept a slightly longer single fill (~30-60 ms
                    // for the extra loads) over visible voids.
                    bool chunkIsCold = !map.HasChunkLoaded(chunkX, chunkY);
                    if (chunkIsCold)
                    {
                        if (_fillLoadBudget > 0)
                        {
                            _fillLoadBudget--;
                        }
                        else if (teleportBurstActive)
                        {
                            // Track for diagnostics but DON'T skip — let
                            // GetChunk2 below load it anyway (land-only).
                            _fillLoadsDeferredThisFill++;
                        }
                        else
                        {
                            _fillLoadsDeferredThisFill++;
                            continue; // skip — chunk renders as nothing this frame
                        }
                    }
#endif
                    // v0.5.17 R3: during teleport burst, load cold chunks with
                    // land tiles only (~5 ms MapBlock read vs ~100 ms statics
                    // IDBFS read). Statics are backfilled by the catchup pass
                    // after the burst ends. Outside burst, always full-load.
#if BROWSER_WASM
                    var __getChunkSw = System.Diagnostics.Stopwatch.StartNew();
#endif
                    var chunk = map.GetChunk2(chunkX, chunkY, true
#if BROWSER_WASM
                        , landOnly: teleportBurstActive && chunkIsCold
#endif
                        );
#if BROWSER_WASM
                    t_getChunk2Ticks += __getChunkSw.ElapsedTicks;
                    n_getChunk2Calls++;
#endif
                    if (chunk == null || chunk.IsDestroyed)
                        continue;

                    // Build chunk mesh if dirty.
                    // v0.4.4: cap mesh.Build calls per fill under BROWSER_WASM
                    // to spread the cost across frames. Operator data showed
                    // ~9 chunks needing Build per chunk-cross at running speed,
                    // each ~3-4ms, summing to ~27-33ms per heavy fill — the
                    // sole source of running microhitches. With a per-fill
                    // budget, total cost stays bounded; chunks not built this
                    // frame stay un-rendered (blank) for one or two frames
                    // until their turn comes. At running speed (~5 tiles/sec)
                    // the visual delay is imperceptible (16-32ms) and the
                    // chunks are at the leading edge of the viewport diamond,
                    // far from the player's gaze focus.
                    bool meshWasDirty = chunk.Mesh.IsDirty;

#if BROWSER_WASM
                    // v0.4.51: chunk-cache replay path. When the chunk is
                    // STABLE (was visible last fill) and CLEAN (mesh not
                    // dirty) and the fill isn't due to an alpha tick, we
                    // can SKIP the inner 8×8 × linked-list iteration and
                    // just replay the cached contributions: mesh-fast-path
                    // objects keep their GPU-buffer visibility flags from
                    // last frame (we skip ResetVisibility too) and just
                    // re-run TrySelectObject so hover stays accurate;
                    // slow-path objects re-enter _renderLists with their
                    // cached `isTransparent` flag. UpdateRealScreenPosition
                    // still runs per object when the camera _offset shifted
                    // — that's the only per-frame work the cache can't
                    // elide. Drops chunk-loop cost from ~14µs/object full-
                    // iteration to ~1-2µs/object on stable+clean chunks.
                    // v0.4.54: removed the `_prevVisibleChunkSet.Contains(chunk)`
                    // restriction. Cache validity itself is the right guard —
                    // when a chunk leaves viewport and re-enters (player turns
                    // around, backtracks, or short teleport into recently-
                    // visited area), its CachedContribsValid persists IFF no
                    // object moved in/out during the off-screen interval
                    // (AddGameObject + RemoveGameObject hooks clear validity
                    // otherwise). Replaying saves a full iteration on chunks
                    // the player keeps cycling through.
                    // v0.4.73: skip cache replay during teleport burst.
                    // Operator data 2026-05-12: post-teleport black persists
                    // until the player walks one tile. Root cause: the FIRST
                    // burst-fill iterates chunks with full clipping against
                    // _minPixel/_maxPixel; tiles outside that range never get
                    // SetVisible() and stay invisible in the GPU buffer. The
                    // cache stores the obj refs but the GPU visibility flag
                    // is what the next frame inherits. Subsequent burst fills
                    // (and steady-state fills until movement) hit cache replay,
                    // which skips ResetVisibility + the clipping check —
                    // GPU buffer keeps the bad visibility from fill #1 → black.
                    // Forcing full iteration through all 5 burst fills lets
                    // each fill re-evaluate _minPixel with the just-settled
                    // post-teleport camera, populating SetVisible correctly
                    // before the cache is later replayed in steady state.
                    // v0.4.54 had this bug too (the cache existed since v0.4.51).
                    // v0.4.79: also deny replay when the player moved since
                    // the last fill (even 1 tile). See playerMovedSinceLastFill
                    // assignment above for rationale.
                    bool cacheReplayAllowed = !meshWasDirty
                        && !_alphaChanged
                        && chunk.CachedContribsValid
                        && !teleportBurstActive
                        && !playerMovedSinceLastFill
                        && ReplayClipCovers(chunk);
                    if (cacheReplayAllowed)
                    {
#if BROWSER_WASM
                        var __replaySw = System.Diagnostics.Stopwatch.StartNew();
                        n_replayPathCalls++;
                        // A replay refreshes the CACHED objects only, so it must not claim the chunk is
                        // positioned: Chunk.RspOffX keeps the offset of the last full walk, and the next full
                        // walk refreshes every object when it differs. The cached objects are refreshed on the
                        // same rule, not only under UpdateDrawPosition - that flag is cleared every fill, so a
                        // chunk skipped by the fill that moved the offset would replay them at the old one.
                        bool replayRefresh = UpdateDrawPosition || chunk.RspOffX != _offset.X || chunk.RspOffY != _offset.Y;
#endif
                        _visibleChunks.Add(chunk);
                        _curVisibleChunkSet.Add(chunk);
                        // Count the chunk as stable in the diff log only when
                        // it was actually in the prev viewport — entered
                        // chunks that hit the cache still report as `entered`
                        // so the operator can see cache effectiveness.
                        if (_prevVisibleChunkSet.Contains(chunk)) chunksStable++;
                        else chunksEntered++;

                        // v0.4.54: per-object "still in this chunk" gate
                        // prevents the duplicate-render fogonazo from
                        // v0.4.51: when a Mobile/Item moves to another
                        // chunk, the source cache still holds the ref
                        // (no whole-chunk invalidation any more). The
                        // gate skips replay for objects whose CURRENT
                        // X/Y no longer maps to this chunk's coords —
                        // they'll be added by their destination chunk's
                        // iteration (AddGameObject invalidates dest cache,
                        // forcing full iteration on the dest side).
                        // Land/Static are fixed in place so this is a
                        // no-op for mesh contribs in practice, but the
                        // check is cheap and defensive.
                        int chunkBaseX = chunk.X;
                        int chunkBaseY = chunk.Y;

                        // Replay mesh fast-path objects (visibility flags
                        // persist in GPU buffer; just refresh hover).
                        var meshContribs = chunk.CachedMeshContribs;
                        for (int i = 0; i < meshContribs.Count; i++)
                        {
                            var mObj = meshContribs[i];
                            if (mObj.IsDestroyed) continue;
                            if ((mObj.X >> 3) != chunkBaseX || (mObj.Y >> 3) != chunkBaseY)
                                continue;
                            if (replayRefresh || mObj.IsPositionChanged)
                            {
                                mObj.UpdateRealScreenPosition(_offset.X, _offset.Y);
                            }
                            TrySelectObject(mObj, true);
                        }

                        // Replay slow-path objects (re-add to _renderLists).
                        var slowContribs = chunk.CachedSlowPathContribs;
                        var slowTrans = chunk.CachedSlowPathTransparent;
                        for (int i = 0; i < slowContribs.Count; i++)
                        {
                            var sObj = slowContribs[i];
                            if (sObj.IsDestroyed) continue;
                            if ((sObj.X >> 3) != chunkBaseX || (sObj.Y >> 3) != chunkBaseY)
                                continue;
                            if (replayRefresh || sObj.IsPositionChanged)
                            {
                                sObj.UpdateRealScreenPosition(_offset.X, _offset.Y);
                            }
                            _renderLists.Add(sObj, slowTrans[i]);
                            TrySelectObject(sObj, true);
                        }

                        // v0.4.52: replay Path A AddLight calls for cached
                        // light-emitting objects. Without this, lights vanish
                        // on cache-replay frames and torches/lanterns flicker
                        // every tile-step (operator runmatch7.log: pathA went
                        // 0↔7 per frame). _inChunkCacheReplay gate stops
                        // AddLight from re-recording.
                        _inChunkCacheReplay = true;
                        var lightObjs = chunk.CachedLightObjects;
                        for (int i = 0; i < lightObjs.Count; i++)
                        {
                            var lObj = lightObjs[i];
                            if (lObj.IsDestroyed) continue;
                            // RealScreenPosition already refreshed above
                            // (every cached light is also in CachedMeshContribs
                            // or CachedSlowPathContribs, both of which run
                            // UpdateRealScreenPosition).
                            AddLight(lObj, lObj, lObj.RealScreenPosition.X + 22, lObj.RealScreenPosition.Y + 22);
                        }
                        _inChunkCacheReplay = false;

                        // Time-budget check on the replay path too — even
                        // cheap replays can stack on hundreds of chunks.
                        //
                        // v0.4.83: skip the bail during teleport burst AND
                        // any other player-move frame (walk step, jump,
                        // server-push). Bailed chunks render BLACK because
                        // _visibleChunks doesn't include them this fill —
                        // a chunk's stale GPU buffer is never reached. The
                        // Tower Defense arena reproduces this: 49 chunks × ~15
                        // items each → cache-replay scales with item-count,
                        // not chunk-count. Operator priority on move frames
                        // is visual correctness over per-frame latency
                        // (matches v0.4.72 rationale for full-iter path).
                        // Cost: occasional 130-200ms hitch when crossing
                        // chunk-edges in item-heavy zones; no black flash.
                        if (!teleportBurstActive
                            && !playerMovedSinceLastFill
                            && chunkLoopSw.ElapsedMilliseconds > CHUNK_LOOP_TIME_BUDGET_MS)
                        {
                            chunkLoopBailed = true;
                            int remainingInY = maxChunkY - chunkY;
                            int remainingX = maxChunkX - chunkX;
                            chunksTimeDeferred = remainingInY + remainingX * (maxChunkY - minChunkY + 1);
#if BROWSER_WASM
                            t_replayTicks += __replaySw.ElapsedTicks;
#endif
                            goto chunkLoopExit;
                        }
#if BROWSER_WASM
                        t_replayTicks += __replaySw.ElapsedTicks;
#endif
                        continue;
                    }

                    // Full iteration path: clear caches; AddTileToRenderList
                    // + PushToRenderQueue + AddLight will repopulate during
                    // this fill.
                    chunk.CachedContribsValid = false;
                    chunk.CachedMeshContribs.Clear();
                    chunk.CachedSlowPathContribs.Clear();
                    chunk.CachedSlowPathTransparent.Clear();
                    chunk.CachedLightObjects.Clear();
#endif

                    if (meshWasDirty)
                    {
#if BROWSER_WASM
                        // v0.4.59: Z-distance LOD gate. Chunks whose content
                        // sits far (|MaxContentZ - playerZ| > Z_LOD_BAND)
                        // from the player's altitude band compete for the
                        // smaller _fillFarZBuildBudget. The player's own
                        // altitude band always gets first dibs on the main
                        // _fillBuildBudget. New chunks (MaxContentZ ==
                        // sbyte.MinValue) are treated as near-Z so they
                        // never starve waiting for the player to know
                        // their Z — they will be reclassified next fill
                        // once their objects have populated MaxContentZ.
                        bool isFarZ = chunk.MaxContentZ != sbyte.MinValue
                            && Math.Abs(chunk.MaxContentZ - playerZForLod) > Z_LOD_BAND;
                        bool buildBudgetAvailable = isFarZ
                            ? _fillFarZBuildBudget > 0
                            : _fillBuildBudget > 0;
                        // v0.4.72: during a teleport burst, force Mesh.Build
                        // on EVERY dirty chunk regardless of budget. Operator
                        // log 2026-05-12T20:45 (eternal britain dx=3946):
                        // fill had dirty=49 build=12 bDef=37 — 37 fresh
                        // chunks fell through `if (!meshHasContent) continue;`
                        // and rendered BLACK because their Mesh.Land hadn't
                        // been built yet. Mesh.Build measured 0 ms in
                        // fill-sub (build=12calls/0ms — just rearranges CPU
                        // arrays; GPU upload is deferred), so forcing 49
                        // builds in the burst-fill adds negligible cost
                        // while eliminating the visible black squares.
                        // Outside the burst, the LOD gate still applies
                        // (steady-state walking: ~4-6 chunk-cross deltas
                        // per frame, fits in 4/1 budget cleanly).
                        // v0.5.19 strategy #1: wall-clock cap applies to BOTH
                        // the count-budgeted path AND the burst-force path.
                        // Note v0.5.19→v0.5.20: bot data confirmed Mesh.Build
                        // is NOT the freeze source (49 calls / 0 ms). Kept
                        // the cap as a safety net but it never trips.
                        bool timeBudgetAvailable = _fillBuildElapsedMs < _fillBuildTimeBudgetMs;
                        bool forceBuildForBurst = teleportBurstActive && !buildBudgetAvailable && timeBudgetAvailable;
                        if ((buildBudgetAvailable && timeBudgetAvailable) || forceBuildForBurst)
                        {
                            var __buildSw = System.Diagnostics.Stopwatch.StartNew();
                            chunk.Mesh.Build(chunk, _world, Client.Game.GraphicsDevice);
                            long __buildTicks = __buildSw.ElapsedTicks;
                            _fillBuildElapsedMs += __buildSw.ElapsedMilliseconds;
                            t_meshBuildSectionTicks += __buildTicks;
                            if (buildBudgetAvailable)
                            {
                                if (isFarZ) _fillFarZBuildBudget--;
                                else        _fillBuildBudget--;
                            }
                            else
                            {
                                // Build was forced during burst — track for
                                // diag (bDef counts "would have deferred")
                                // but no budget decrement (already exhausted).
                                _fillBuildsDeferredThisFill++;
                            }
                            // v0.4.71-diag: emit per-chunk Build outcome for
                            // the first teleport-burst fill. If Land.Count==0
                            // OR Statics.Count==0 on a chunk that visually
                            // SHOULD have content (any britain chunk has 64
                            // land tiles, most have statics), the bug is
                            // server-stream lag (statics arriving after Build)
                            // or chunk.AddGameObject failing post-Destroy.
                            if (_teleDiagDumpChunks)
                            {
                                Console.WriteLine($"[tele-chunk] f{_teleDiagBurstFillIdx} cx={chunk.X} cy={chunk.Y} maxZ={chunk.MaxContentZ} isFarZ={isFarZ} land={chunk.Mesh.Land.Count} statics={chunk.Mesh.Statics.Count} entered={(_prevVisibleChunkSet.Contains(chunk) ? 0 : 1)} forced={(forceBuildForBurst ? 1 : 0)}");
                            }
                        }
                        else if (isFarZ)
                        {
                            // Far-Z budget exhausted. Defer the build to
                            // next fill (renders blank/stale this frame).
                            // This is the LOD-streaming gradient: distant
                            // terrain fades in gradually instead of
                            // all-at-once.
                            chunksDeferredFarZ++;
                            _fillBuildsDeferredThisFill++;
                            bool meshHasContentFarZ = chunk.Mesh.Land.Count > 0
                                || chunk.Mesh.Statics.Count > 0;
                            if (!meshHasContentFarZ)
                            {
                                _visibleChunks.Add(chunk);
                                _curVisibleChunkSet.Add(chunk);
                                chunksDirty++;
                                continue;
                            }
                            // Has stale buffer — fall through to render it.
                        }
                        else
                        {
                            // v0.4.10: render with stale GPU buffer instead
                            // of skipping. The pre-v0.4.10 path skipped
                            // AddTileToRenderList when the build budget
                            // was exhausted, which dropped AddLight calls
                            // for static lights on those chunks. On Sphere
                            // shards the chunk-dirty rate is much higher
                            // than on ModernUO (more aggressive object
                            // updates) so several chunks defer per fill,
                            // their lights vanish for one frame and return
                            // the next — visible 30 Hz "fluorescent"
                            // flicker on every torch/lantern in view.
                            //
                            // Pre-v0.4.4 (no budget) never had this: every
                            // dirty chunk rebuilt every fill. v0.4.4 traded
                            // that for the budget but accidentally also
                            // skipped rendering. The buffer holds 1-2 frame
                            // stale geometry — invisible visually, while
                            // the lights (computed from chunk.Tiles, not
                            // from the GPU buffer) become correct again.
                            //
                            // Fresh-loaded chunks (Land.Count == 0 &&
                            // Statics.Count == 0) keep the skip path:
                            // there is no stale buffer, rendering would
                            // show empty terrain. They wait one fill for
                            // the build budget to free up.
                            bool meshHasContent = chunk.Mesh.Land.Count > 0
                                || chunk.Mesh.Statics.Count > 0;
                            if (!meshHasContent)
                            {
                                _fillBuildsDeferredThisFill++;
                                _visibleChunks.Add(chunk);
                                _curVisibleChunkSet.Add(chunk);
                                chunksDirty++;
                                continue; // empty mesh, no stale buffer
                            }
                            // Defer build but render with stale buffer.
                            _fillBuildsDeferredThisFill++;
                            // Fall through to ResetVisibility +
                            // AddTileToRenderList — the chunksDirty++ and
                            // _visibleChunks/_curVisibleChunkSet adds
                            // happen in the existing post-build path.
                        }
#else
                        chunk.Mesh.Build(chunk, _world, Client.Game.GraphicsDevice);
#endif
                    }

                    // Reset visibility and alpha for this frame
#if BROWSER_WASM
                    var __resetLandSw = System.Diagnostics.Stopwatch.StartNew();
#endif
                    chunk.Mesh.Land.ResetVisibility();
                    chunk.Mesh.Land.ResetAlpha();
#if BROWSER_WASM
                    t_resetLandTicks += __resetLandSw.ElapsedTicks;
                    var __resetStaticsSw = System.Diagnostics.Stopwatch.StartNew();
#endif
                    chunk.Mesh.Statics.ResetVisibility();
                    chunk.Mesh.Statics.ResetAlpha();
#if BROWSER_WASM
                    t_resetStaticsTicks += __resetStaticsSw.ElapsedTicks;
                    var __bkSw = System.Diagnostics.Stopwatch.StartNew();
#endif

                    _visibleChunks.Add(chunk);

#if BROWSER_WASM
                    // Count for the chunk-diff diag. NO behavioural change —
                    // we still ResetVisibility + iterate Lands above.
                    _curVisibleChunkSet.Add(chunk);
                    if (meshWasDirty)
                    {
                        chunksDirty++;
                    }
                    else if (_prevVisibleChunkSet.Contains(chunk))
                    {
                        chunksStable++;
                    }
                    else
                    {
                        chunksEntered++;
                    }
                    t_visBookkeepTicks += __bkSw.ElapsedTicks;
#endif

#if BROWSER_WASM
                    // v0.4.75-diag: reset Land counters BEFORE the 8×8 sweep
                    // so they capture only THIS chunk's stats. Counters live
                    // on the partial-class so AddTileToRenderList writes into
                    // them; the dump below reads + resets.
                    if (_teleDiagDumpChunks)
                    {
                        _diagLandIter = 0;
                        _diagLandClipX = 0;
                        _diagLandClipY = 0;
                        _diagLandMaxZ = 0;
                        _diagLandAlphaPromoted = 0;
                        _diagLandSetVis = 0;
                        _diagLandSpriteMissing = 0;
                    }
#endif
#if BROWSER_WASM
                    var __iterSw = System.Diagnostics.Stopwatch.StartNew();
                    n_iteratePathCalls++;
#endif
                    for (var x = 0; x < 8; x++)
                    {
                        for (var y = 0; y < 8; y++)
                        {
                            var firstObj = chunk.GetHeadObject(x, y);
                            if (firstObj == null || firstObj.IsDestroyed)
                                continue;

                            AddTileToRenderList(
                                firstObj,
                                use_handles,
                                150,
                                chunk
                            );
                        }
                    }
#if BROWSER_WASM
                    t_iterateTicks += __iterSw.ElapsedTicks;
#endif

#if BROWSER_WASM
                    // v0.4.75-diag: dump per-chunk Land iteration stats during
                    // the first fill of a teleport burst. If iter==64 then
                    // every tile entered AddTileToRenderList; setVis==64 means
                    // all 64 hit SetVisible (rendered). A gap iter==64 setVis<64
                    // tells us where the tiles got dropped — clipY (off
                    // canvas), maxZ (above _maxZ cull), spriteMissing
                    // (Mesh.Build skipped this tile). iter<64 means some
                    // (x,y) cells had a head-of-linked-list object whose
                    // screenX broke out (clipX is hit on the FIRST object's
                    // X-axis check), so subsequent tiles in that cell never
                    // ran. v0.4.74 AlphaHue promotion firings shown by
                    // alphaPromoted — non-zero count = chunk had fresh-built
                    // tiles in the first place.
                    if (_teleDiagDumpChunks)
                    {
                        Console.WriteLine(
                            $"[tele-land-stats] f{_teleDiagBurstFillIdx} cx={chunk.X} cy={chunk.Y} " +
                            $"iter={_diagLandIter} setVis={_diagLandSetVis} " +
                            $"clipY={_diagLandClipY} maxZ={_diagLandMaxZ} " +
                            $"alphaProm={_diagLandAlphaPromoted} " +
                            $"sprMiss={_diagLandSpriteMissing} " +
                            $"meshLand={chunk.Mesh.Land.Count}"
                        );
                    }

                    // v0.4.51: iteration just populated this chunk's replay
                    // caches via AddTileToRenderList + PushToRenderQueue.
                    // Mark valid so the next stable+clean cache-MISS skips
                    // the iteration in favour of cheap replay.
                    chunk.CachedContribsValid = true;
                    // Every chain of the chunk was walked, and AddTileToRenderList refreshed each one whole
                    // whenever the offset had moved - so every object now sits at this offset.
                    chunk.RspOffX = _offset.X;
                    chunk.RspOffY = _offset.Y;
                    // ...and remember the view it was clipped under (see ReplayClipCovers).
                    chunk.CachedClipOffX = _offset.X;
                    chunk.CachedClipOffY = _offset.Y;
                    chunk.CachedClipMinX = _minPixel.X;
                    chunk.CachedClipMinY = _minPixel.Y;
                    chunk.CachedClipMaxX = _maxPixel.X;
                    chunk.CachedClipMaxY = _maxPixel.Y;
                    chunk.CachedClipZoom = Camera.Zoom;

                    // v0.4.51: time-budget check at chunk boundary using
                    // Stopwatch (TickCount64 was unreliable inside a single
                    // tick on Mono MT). Bails out of both outer loops once
                    // the cap is hit; chunks not yet visited roll over to
                    // the next fill.
                    //
                    // v0.4.72: skip the bail during teleport burst — bailed
                    // chunks render as black (fresh-loaded chunks have no
                    // stale buffer to fall back on). Operator priority is
                    // visual correctness over latency in the burst window.
                    // v0.4.83: extended to ALL player-move frames (walk step
                    // included) — Tower Defense arena reproduced ~63% black
                    // wedge on WALK step 4 because full-iter of 50 item-heavy
                    // chunks > 100 ms bailed mid-loop. Symmetric with the
                    // cache-replay bail above.
                    if (!teleportBurstActive
                        && !playerMovedSinceLastFill
                        && chunkLoopSw.ElapsedMilliseconds > CHUNK_LOOP_TIME_BUDGET_MS)
                    {
                        chunkLoopBailed = true;
                        int remainingInY = maxChunkY - chunkY;
                        int remainingX = maxChunkX - chunkX;
                        chunksTimeDeferred = remainingInY + remainingX * (maxChunkY - minChunkY + 1);
                        goto chunkLoopExit;
                    }
#endif
                }
            }
#if BROWSER_WASM
            chunkLoopExit:;
#endif

#if BROWSER_WASM
            // v0.5.17 R3: statics catchup pass. After a burst fill, cold chunks
            // have land tiles only (StaticsLoaded=false). Each non-burst fill
            // loads statics for up to STATICS_CATCHUP_PER_FILL chunks, spreading
            // the ~100ms/chunk IDBFS cost across frames instead of one big freeze.
            // At 2/fill, Britain's 41 deferred chunks drain in ~21 fills (~350ms
            // nominal at 60fps; actual depends on I/O — but each frame costs only
            // 2×~100ms=200ms instead of 41×100ms=4100ms in a single frame).
            if (!teleportBurstActive)
            {
                var __catchupSw = System.Diagnostics.Stopwatch.StartNew();
                // v0.8.88: the old pass loaded only 2 statics-chunks per fill,
                // always scanning from the (minChunkX,minChunkY) corner. While
                // the player walked, far chunks evicted before the corner-first
                // scan reached them → "half the statics don't render until you
                // stand still / reopen" (operator bug). The 2/fill cap was sized
                // for a stale "~100 ms/chunk IDBFS" cost; since v0.8.16 statics
                // read from MEMFS (~0-6 ms), so we can afford a real budget.
                //
                // New pass: (1) prioritise chunks NEAREST the camera centre via
                // concentric Chebyshev rings, so the statics the player actually
                // sees fill first; (2) bound by a ~4 ms TIME budget (self-tunes to
                // real I/O) with a hard count cap as a safety rail — never the
                // old 41×100 ms single-frame freeze, never the 2/fill starvation.
                const int STATICS_CATCHUP_MAX = 48;
                long budgetTicks = System.Diagnostics.Stopwatch.Frequency / 250; // ~4 ms
                int ccx = (minChunkX + maxChunkX) >> 1;
                int ccy = (minChunkY + maxChunkY) >> 1;
                int maxR = Math.Max(Math.Max(ccx - minChunkX, maxChunkX - ccx),
                                    Math.Max(ccy - minChunkY, maxChunkY - ccy));
                int staticsCaughtUp = 0;
                bool stopCatchup = false;
                bool catchupBudgetHit = false;
                for (int r = 0; r <= maxR && !stopCatchup; r++)
                {
                    for (int cx = ccx - r; cx <= ccx + r && !stopCatchup; cx++)
                    {
                        for (int cy = ccy - r; cy <= ccy + r && !stopCatchup; cy++)
                        {
                            // Ring border only (Chebyshev distance == r) so each
                            // chunk is visited exactly once across the ring loop.
                            if (Math.Max(Math.Abs(cx - ccx), Math.Abs(cy - ccy)) != r) continue;
                            if (cx < minChunkX || cx > maxChunkX || cy < minChunkY || cy > maxChunkY) continue;
                            Chunk sc = map.GetChunk2(cx, cy, false);
                            if (sc != null && !sc.IsDestroyed && !sc.StaticsLoaded)
                            {
                                sc.LoadStaticsOnly(map.Index);
                                if (++staticsCaughtUp >= STATICS_CATCHUP_MAX) { stopCatchup = true; catchupBudgetHit = true; break; }
                                if (__catchupSw.ElapsedTicks >= budgetTicks) { stopCatchup = true; catchupBudgetHit = true; break; }
                            }
                        }
                    }
                }
                t_catchupTicks += __catchupSw.ElapsedTicks;

                // ── v0.8.89 instrumentation (operator bug "half the statics
                //    missing while walking" NOT fixed by the rings pass) ──
                // Console.WriteLine (not WasmTrace — that's compiled out in
                // prod) so the operator's ?dev=1 log shows: (a) WHICH engine
                // this session runs (the v0.8.88 log was indistinguishable
                // from the old one), (b) whether chunks remain statics-pending
                // after each catchup (starvation), (c) whether chunks were
                // hydrated from a PERSISTED OPFS snapshot with zero statics
                // while staidx says the block HAS statics — the poisoned
                // cross-session snapshot suspect. Logged at most 1/s and only
                // when there's signal, so steady-state stays quiet.
                if (!_staticsCatchupBannerShown)
                {
                    _staticsCatchupBannerShown = true;
                    Console.WriteLine($"[statics-catchup] ENGINE=rings-v2-20260612 cap={STATICS_CATCHUP_MAX} budget~4ms");
                }
                long nowMs = Environment.TickCount64;
                if (nowMs - _lastCatchupLogMs >= 1000)
                {
                    int pendingAfter = 0;
                    for (int cx = minChunkX; cx <= maxChunkX; cx++)
                    {
                        for (int cy = minChunkY; cy <= maxChunkY; cy++)
                        {
                            Chunk pc = map.GetChunk2(cx, cy, false);
                            if (pc != null && !pc.IsDestroyed && !pc.StaticsLoaded) pendingAfter++;
                        }
                    }
                    if (staticsCaughtUp > 0 || pendingAfter > 0 ||
                        Chunk.SnapHydrated != _lastSnapHydrated)
                    {
                        Console.WriteLine(
                            $"[statics-catchup] caughtUp={staticsCaughtUp} pendingAfter={pendingAfter} budgetHit={(catchupBudgetHit ? 1 : 0)}" +
                            $" snapHydr={Chunk.SnapHydrated} snapZero={Chunk.SnapHydratedZeroStatics} snapSUSPECT={Chunk.SnapHydratedSuspect} snapStale={Chunk.SnapRejectedStale} snapLossySkip={ChunkSnapshot.CaptureSkippedLossy}");
                        _lastCatchupLogMs = nowMs;
                        _lastSnapHydrated = Chunk.SnapHydrated;
                    }
                }
            }
#endif

#if BROWSER_WASM
            // v0.4.11 lights-diag: chunk loop done — flip flag back so
            // any AddLight call after this is counted as Path B.
            _lightDiagInChunkLoop = false;
            // v0.4.12: snapshot K_static_mesh = _lightCount RIGHT NOW,
            // before DrawRenderLists's Path B starts adding dynamic
            // lights. The next cache hit will restore _lightCount to
            // this value so Path B overwrites instead of appends.
            _lightCountAfterChunkLoop = _lightCount;
#endif

#if BROWSER_WASM
            // v0.4.0 chunk-diff log. `left` = chunks in the previous fill
            // that aren't in the current one. Rate-limited to 1/sec so
            // the dev console stays readable while walking. After the
            // log, swap the sets so next fill compares against this one.
            long chunkLoopMs = chunkSw.ElapsedMilliseconds;
            long nowChunksDiff = Environment.TickCount64;
            // v0.4.2: same fix as fill-sub — always log heavy chunk loops
            // (>=5 ms) plus a 1/sec sample, so we don't miss the spikes.
            bool heavyChunk = chunkLoopMs >= 5;
            if (heavyChunk || (nowChunksDiff - _chunksDiffLastLog >= 1000))
            {
                _chunksDiffLastLog = nowChunksDiff;
                int chunksLeft = 0;
                foreach (var prev in _prevVisibleChunkSet)
                {
                    if (!_curVisibleChunkSet.Contains(prev))
                    {
                        chunksLeft++;
                    }
                }
                int total = chunksEntered + chunksStable + chunksDirty;
                string farZSuffix = chunksDeferredFarZ > 0
                    ? $" farZDef={chunksDeferredFarZ}@pZ={playerZForLod}"
                    : "";
                Console.WriteLine(
                    $"[chunks-diff] entered={chunksEntered} left={chunksLeft} stable={chunksStable} dirty={chunksDirty} total={total} fillMs={chunkLoopMs}{(chunkLoopBailed ? $" BAILED defer={chunksTimeDeferred}" : "")}{farZSuffix}"
                );
                // v0.5.20 strategy #5: breakdown of chunkLoopMs into sections
                // so we can see WHERE the 4-5 s freeze lives. Only emit for
                // heavy fills (>= 50 ms) to avoid log spam during walking.
                if (chunkLoopMs >= 50)
                {
                    // v0.5.23: ticks → ms conversion at end of fill (sub-ms
                    // per-chunk work was lost in integer rounding before).
                    long ticksPerMs = System.Diagnostics.Stopwatch.Frequency / 1000;
                    if (ticksPerMs <= 0) ticksPerMs = 1;
                    long t_getChunk2Ms = t_getChunk2Ticks / ticksPerMs;
                    long t_buildMs    = t_meshBuildSectionTicks / ticksPerMs;
                    long t_replayMs   = t_replayTicks / ticksPerMs;
                    long t_iterMs     = t_iterateTicks / ticksPerMs;
                    long t_resetLand  = t_resetLandTicks / ticksPerMs;
                    long t_resetStat  = t_resetStaticsTicks / ticksPerMs;
                    long t_bk         = t_visBookkeepTicks / ticksPerMs;
                    long t_catchup    = t_catchupTicks / ticksPerMs;
                    long t_dirtyCk    = t_dirtyCheckTicks / ticksPerMs;
                    long t_accounted = t_getChunk2Ms + t_buildMs + t_replayMs + t_iterMs
                                       + t_resetLand + t_resetStat + t_bk + t_catchup + t_dirtyCk;
                    long t_other = chunkLoopMs - t_accounted;
                    long zHits = Map.Map.ZBlockCacheHits;
                    long zMiss = Map.Map.ZBlockCacheMisses;
                    long zTotal = zHits + zMiss;
                    int zHitPct = zTotal > 0 ? (int)((zHits * 100) / zTotal) : 0;
                    Map.Map.ZBlockCacheHits = 0;
                    Map.Map.ZBlockCacheMisses = 0;
                    // v0.5.25 F1: chunk-snapshot cache stats
                    long snapHits = Map.ChunkSnapshot.CacheHits;
                    long snapMiss = Map.ChunkSnapshot.CacheMisses;
                    long snapSaved = Map.ChunkSnapshot.CacheSavedChunks;
                    long snapTotal = snapHits + snapMiss;
                    int snapHitPct = snapTotal > 0 ? (int)((snapHits * 100) / snapTotal) : 0;
                    Map.ChunkSnapshot.CacheHits = 0;
                    Map.ChunkSnapshot.CacheMisses = 0;
                    Map.ChunkSnapshot.CacheSavedChunks = 0;
                    Console.WriteLine(
                        $"[chunk-profile] fillMs={chunkLoopMs} getChunk2={t_getChunk2Ms}/{n_getChunk2Calls} build={t_buildMs} replay={t_replayMs}/{n_replayPathCalls} iter={t_iterMs}/{n_iteratePathCalls} resetLand={t_resetLand} resetStat={t_resetStat} bk={t_bk} catchup={t_catchup} dirtyCk={t_dirtyCk} other={t_other} acc={t_accounted}/{chunkLoopMs} zC={zHits}h/{zMiss}m({zHitPct}%) snapC={snapHits}h/{snapMiss}m({snapHitPct}%) snapSaved={snapSaved}"
                    );
                }
            }
            // Swap sets — current becomes previous for next fill.
            // Avoid allocating: clear prev, add current items, reuse.
            _prevVisibleChunkSet.Clear();
            foreach (var c in _curVisibleChunkSet)
            {
                _prevVisibleChunkSet.Add(c);
            }
#endif

#if BROWSER_WASM
            var foliSw = System.Diagnostics.Stopwatch.StartNew();
#endif
            if (_alphaChanged)
            {
                for (int i = 0; i < _foliageCount; i++)
                {
                    GameObject f = _foliages[i];

                    if (f.FoliageIndex == FoliageIndex)
                    {
                        CalculateAlpha(ref f.AlphaHue, Constants.FOLIAGE_ALPHA);
                    }
                    else if (f.Z < _maxZ)
                    {
                        CalculateAlpha(ref f.AlphaHue, 0xFF);
                    }
                }
            }
#if BROWSER_WASM
            fillSubFoliMs = foliSw.ElapsedMilliseconds;
            var textMobSw = System.Diagnostics.Stopwatch.StartNew();
#endif

            UpdateTextServerEntities(_world.Mobiles.Values, true);
#if BROWSER_WASM
            fillSubTextMobMs = textMobSw.ElapsedMilliseconds;
            var textItmSw = System.Diagnostics.Stopwatch.StartNew();
#endif
            UpdateTextServerEntities(_world.Items.Values, false);
#if BROWSER_WASM
            fillSubTextItmMs = textItmSw.ElapsedMilliseconds;
#endif

            // v0.4.20.3: second-pass mobile-bbox rescue. After the chunk
            // loop's pixel-perfect pass finishes, if no real object hit
            // (SelectedObject is null or only Land), check whether the
            // cursor lands inside any visible mobile's StableHitBox.
            // Without this, alpha-jitter on idle anim frames causes
            // ~75% of clicks on mobiles to fall through to the Land
            // underneath. With it, those clicks are recovered as mobile
            // hits — but only when no other object pixel-hit, so a
            // pixel-perfect static / item / corpse behind the mob keeps
            // its click (e.g. door behind a mounted player still opens).
            TryRescueMobileSelectionViaBbox();

            // v0.4.47 (supersedes v0.4.44): snapshot the resolved non-Mobile
            // selection so the next cache-HIT frame can restore it WITHOUT
            // re-iterating the 5 _renderLists. Non-Mobile sprites have
            // deterministic CheckMouseSelection results under the cache-key
            // invariants (mouse + player + offset + bounds + zoom all
            // unchanged), so the cached resolution is bit-identical to a
            // fresh fill at the same mouse position. Mobiles are excluded
            // because they anim-tick independent of player/mouse motion —
            // RefreshSelectedObjectFromCachedRenderLists still iterates
            // _renderLists.Animations + runs TryRescueMobileSelectionViaBbox
            // on cache hits so anim-shifted mobiles can claim selection.
            {
                var so = SelectedObject.Object as GameObject;
                _cachedNonMobileSelection = (so != null && so is not Mobile) ? so : null;
            }

            UpdateDrawPosition = false;

#if BROWSER_WASM
            // v0.4.1: emit one combined sub-stage line per second so we can
            // see the full breakdown of FillGameObjectList in the browser
            // console. mobN/itmN counts surface scale of UpdateText* iterations.
            long fillSubTotalMs = fillSubSw.ElapsedMilliseconds;
            long fillSubNow = Environment.TickCount64;
            // v0.4.2: always log heavy fills (>=5 ms), plus a 1/sec sample
            // for cheap fills. The 1/sec rate-limit alone in v0.4.1 missed
            // the heavy fills (operator log: Draw.FillObj=35-50 ms but
            // fill-sub samples all 0 ms because the heavy fills happened
            // between two cheap-fill samples that hit the rate-limit cap).
            bool heavyFill = fillSubTotalMs >= 5;
            bool periodicSample = fillSubNow - _fillSubLastLog >= 1000;
            if (heavyFill || periodicSample)
            {
                _fillSubLastLog = fillSubNow;
                int mobN = _world.Mobiles.Count;
                int itmN = _world.Items.Count;
                // v0.4.3: include MarkDirty counters so we can see who's
                // invalidating chunk meshes per fill. Reset after read.
                int markLand = Map.ChunkMesh.LandMarks;
                int markStatic = Map.ChunkMesh.StaticMarks;
                int markMulti = Map.ChunkMesh.MultiMarks;
                int markTrans = Map.ChunkMesh.TransitionsToDirty;
                long buildMs = Map.ChunkMesh.BuildTotalMs;
                int buildCalls = Map.ChunkMesh.BuildCalls;
                int softClearCalls = Map.ChunkMesh.SoftClearCalls;
                Map.ChunkMesh.LandMarks = 0;
                Map.ChunkMesh.StaticMarks = 0;
                Map.ChunkMesh.MultiMarks = 0;
                Map.ChunkMesh.TransitionsToDirty = 0;
                Map.ChunkMesh.BuildTotalMs = 0;
                Map.ChunkMesh.BuildCalls = 0;
                Map.ChunkMesh.SoftClearCalls = 0;
                Console.WriteLine(
                    $"[fill-sub] gvp={fillSubGvpMs}ms foli={fillSubFoliMs}ms textMob={fillSubTextMobMs}ms textItm={fillSubTextItmMs}ms total={fillSubTotalMs}ms mobN={mobN} itmN={itmN} build={buildCalls}calls/{buildMs}ms fillBuildMs={_fillBuildElapsedMs}/{_fillBuildTimeBudgetMs} bDef={_fillBuildsDeferredThisFill} lDef={_fillLoadsDeferredThisFill} softClr={softClearCalls} dirtyTrans={markTrans} burstRem={_fillTeleportRemainingFills}{(heavyFill ? " HEAVY" : "")}"
                );
            }
            // v0.4.71-diag: clear the per-chunk dump flag at end-of-fill so
            // only the FIRST burst-fill emits [tele-chunk] lines (avoids
            // 5× spam during the 5-fill burst window).
            _teleDiagDumpChunks = false;
            // v0.5.20: removed v0.5.19 auto-extend — the bot measurement showed
            // it regressed (40 %→52 % freezes ≥1 s) because extending the burst
            // delays the catchup pass (which is gated on !teleportBurstActive),
            // so statics never get a chance to load incrementally. The 4–5 s
            // freeze is also NOT in Mesh.Build (measured 0 ms across 49 calls)
            // — it's elsewhere in the chunk loop. v0.5.20 adds [chunk-profile]
            // log to find out where.
#endif
        }

        private void UpdateTextServerEntities<T>(IEnumerable<T> entities, bool force)
            where T : Entity
        {
            foreach (T e in entities)
            {
                if (
                    e.TextContainer != null
                    && !e.TextContainer.IsEmpty
                    && (force || e.Graphic == 0x2006)
                )
                {
                    e.UpdateRealScreenPosition(_offset.X, _offset.Y);
                }
            }
        }

        public override void Update()
        {
            Profile currentProfile = ProfileManager.CurrentProfile;

            SelectedObject.TranslatedMousePositionByViewport = Camera.MouseToWorldPosition();

            // First-login window layout (operator 2026-07-10): inert single-bool
            // check unless LoginComplete armed it on a fresh profile.
            FirstLoginGumpPreset.Update(_world);

            // --- Facet swap instrumentation (R1) ---
            // Fired BEFORE base.Update so the JS-side performance.mark
            // captures "first Update entered" — the moment the runtime
            // returned from the swap's heavy setter and re-took the per-
            // frame tick. TickFacetTransition runs once/frame and auto-
            // clears the flag after FACET_TRANSITION_FRAMES (30) ticks.
            _world.NotifyFirstUpdateAfterSwap();
            _world.TickFacetTransition();

#if BROWSER_WASM
            // v0.3.36 lag diagnostic — extended in v0.3.36-bis to also cover
            // base.Update (Scene base class → UIManager paint pass + tooltip
            // refresh + cursor update). Operator log 2026-05-06 showed only
            // AnimStatics hitting the 5 ms threshold inside the labelled
            // subsystems (4 events in 46 s) yet 33 of 37 long-frames had no
            // explanation. Adding base.Update + Draw timing here. Static
            // stopwatch + dict so the timing itself does not allocate
            // per-frame.
            _lagSw.Restart();
#endif

            base.Update();
#if BROWSER_WASM
            LagCheckpoint("base.Update");
#endif

            if (_time_cleanup < Time.Ticks)
            {
#if BROWSER_WASM
                // v0.4.5: skip ClearUnusedBlocks under WASM. Profiling
                // (v0.4.4 data: total=28-34ms with build=2calls/0ms)
                // showed that the destroy→pool→Load cycle was the running-
                // hitch source — not mesh.Build. Each chunk-cross at running
                // speed destroys ~9 stale chunks (LastAccessTime > 3s old)
                // that the player just walked past, then dequeues them
                // back from the pool ~150ms later when the player advances
                // further and new chunks enter the viewport. The dequeue
                // calls chunk.Load(Index), which reads MapBlock + creates
                // 64 Lands + N Statics — ~3 ms per chunk × 9 = 27 ms hitch.
                //
                // Skipping cleanup under WASM keeps recently-visited chunks
                // alive in memory. Trade-off: memory grows linearly with
                // exploration area. Estimated ~5 KB per chunk × ~hundreds
                // of chunks per session = a few MB. Modern PCs have GB.
                // Map.Destroy() still fires on map-change so the per-map
                // chunk pool resets when the player teleports across maps.
#else
                _world.Map?.ClearUnusedBlocks();
#endif
                _time_cleanup = Time.Ticks + 500;
            }
#if BROWSER_WASM
            LagCheckpoint("ClearUnusedBlocks");
#endif

            PacketHandlers.SendMegaClilocRequests(_world);
#if BROWSER_WASM
            LagCheckpoint("MegaCliloc");
#endif

            if (_forceStopScene)
            {
                LoginScene loginScene = new LoginScene(_world);
                Client.Game.SetScene(loginScene);
                loginScene.Reconnect = true;

                return;
            }

            if (!_world.InGame)
            {
                return;
            }

            if (Time.Ticks > _timePing)
            {
                NetClient.Socket.Statistics.SendPing();
                _timePing = (long)Time.Ticks + 1000;
            }

            _world.Update();
#if BROWSER_WASM
            LagCheckpoint("World.Update");
#endif
            // --- Transition mode gate (R1 step 2) ---
            // Skip animation interpolation while a facet swap is in
            // flight: animated statics (flames, torches, moongates) end
            // up referencing chunks the new MapLoader is still
            // populating, and the interp work amortizes into the swap
            // freeze. Sprites stay on the keyframe they had at swap
            // begin — 30 frames at 60 FPS = 500 ms max stale, recovers
            // instantly when the flag clears.
            if (!_world.InFacetTransition)
            {
                _animatedStaticsManager.Process();
            }
#if BROWSER_WASM
            LagCheckpoint("AnimStatics");
#endif
            _world.BoatMovingManager.Update();
#if BROWSER_WASM
            LagCheckpoint("BoatMoving");
#endif
            _world.Player.Pathfinder.ProcessAutoWalk();
#if BROWSER_WASM
            LagCheckpoint("AutoWalk");
#endif
            _world.DelayedObjectClickManager.Update();
#if BROWSER_WASM
            LagCheckpoint("DelayedClick");
#endif

            if (!MoveCharacterByMouseInput() && !currentProfile.DisableArrowBtn)
            {
                Direction dir = DirectionHelper.DirectionFromKeyboardArrows(
                    _flags[0],
                    _flags[2],
                    _flags[1],
                    _flags[3]
                );

                if (_world.InGame && !_world.Player.Pathfinder.AutoWalking && dir != Direction.NONE)
                {
                    _world.Player.Walk(dir, currentProfile.AlwaysRun);
                }
            }

            if (
                _followingMode && SerialHelper.IsMobile(_followingTarget) && !_world.Player.Pathfinder.AutoWalking
            )
            {
                Mobile follow = _world.Mobiles.Get(_followingTarget);

                if (follow != null)
                {
                    int distance = follow.Distance;

                    if (distance > _world.ClientViewRange)
                    {
                        StopFollowing();
                    }
                    else if (distance > 3)
                    {
                        _world.Player.Pathfinder.WalkTo(follow.X, follow.Y, follow.Z, 1);
                    }
                }
                else
                {
                    StopFollowing();
                }
            }

            _world.Macros.Update();

            if (
                (currentProfile.CorpseOpenOptions == 1 || currentProfile.CorpseOpenOptions == 3)
                    && _world.TargetManager.IsTargeting
                || (currentProfile.CorpseOpenOptions == 2 || currentProfile.CorpseOpenOptions == 3)
                    && _world.Player.IsHidden
            )
            {
                _useItemQueue.ClearCorpses();
            }

            _useItemQueue.Update();

            if (!UIManager.IsMouseOverWorld)
            {
                SelectedObject.Object = null;
            }

            if (
                _world.TargetManager.IsTargeting
                && _world.TargetManager.TargetingState == CursorTarget.MultiPlacement
                && _world.CustomHouseManager == null
                && _world.TargetManager.MultiTargetInfo != null
            )
            {
                if (_multi == null)
                {
                    _multi = Item.Create(_world, 0);
                    _multi.Graphic = _world.TargetManager.MultiTargetInfo.Model;
                    _multi.Hue = _world.TargetManager.MultiTargetInfo.Hue;
                    _multi.IsMulti = true;
                }

                if (SelectedObject.Object is GameObject gobj)
                {
                    ushort x,
                        y;
                    sbyte z;

                    int cellX = gobj.X % 8;
                    int cellY = gobj.Y % 8;

                    GameObject o = _world.Map.GetChunk(gobj.X, gobj.Y)?.Tiles[cellX, cellY];

                    if (o != null)
                    {
                        x = o.X;
                        y = o.Y;
                        z = o.Z;
                    }
                    else
                    {
                        x = gobj.X;
                        y = gobj.Y;
                        z = gobj.Z;
                    }

                    _world.Map.GetMapZ(x, y, out sbyte groundZ, out sbyte _);

                    if (gobj is Static st && st.ItemData.IsWet)
                    {
                        groundZ = gobj.Z;
                    }

                    x = (ushort)(x - _world.TargetManager.MultiTargetInfo.XOff);
                    y = (ushort)(y - _world.TargetManager.MultiTargetInfo.YOff);
                    z = (sbyte)(groundZ - _world.TargetManager.MultiTargetInfo.ZOff);

                    _multi.SetInWorldTile(x, y, z);
                    _multi.CheckGraphicChange();

                    _world.HouseManager.TryGetHouse(_multi.Serial, out House house);

                    foreach (Multi s in house.Components)
                    {
                        s.IsHousePreview = true;
                        s.SetInWorldTile(
                            (ushort)(_multi.X + s.MultiOffsetX),
                            (ushort)(_multi.Y + s.MultiOffsetY),
                            (sbyte)(_multi.Z + s.MultiOffsetZ)
                        );
                    }
                }
            }
            else if (_multi != null)
            {
                _world.HouseManager.RemoveMultiTargetHouse();
                _multi.Destroy();
                _multi = null;
            }

            if (_isMouseLeftDown && !Client.Game.UO.GameCursor.ItemHold.Enabled)
            {
                if (
                    _world.CustomHouseManager != null
                    && _world.CustomHouseManager.SelectedGraphic != 0
                    && !_world.CustomHouseManager.SeekTile
                    && !_world.CustomHouseManager.Erasing
                    && Time.Ticks > _timeToPlaceMultiInHouseCustomization
                )
                {
                    if (
                        SelectedObject.Object is GameObject obj
                        && (
                            obj.X != _lastSelectedMultiPositionInHouseCustomization.X
                            || obj.Y != _lastSelectedMultiPositionInHouseCustomization.Y
                        )
                    )
                    {
                        _world.CustomHouseManager.OnTargetWorld(obj);
                        _timeToPlaceMultiInHouseCustomization = Time.Ticks + 50;
                        _lastSelectedMultiPositionInHouseCustomization.X = obj.X;
                        _lastSelectedMultiPositionInHouseCustomization.Y = obj.Y;
                    }
                }
                else if (Time.Ticks - _holdMouse2secOverItemTime >= 1000)
                {
                    if (SelectedObject.Object is Item it && GameActions.PickUp(_world, it.Serial, 0, 0))
                    {
                        _isMouseLeftDown = false;
                        _holdMouse2secOverItemTime = 0;
                    }
                }
            }
#if BROWSER_WASM
            // v0.4.48: anchor end-of-Update wallclock for the long-frame
            // breakdown in GameController. Lets the [perf] log split frame
            // time into C#-Update / C#-Draw / js-gap buckets.
            GameController.WasmUpdateEndMs = Environment.TickCount64;
#endif
        }

        // Smoothing mode with the legacy-profile derive (task #163): profiles
        // saved before the 5-way selector carry -1 and fall back to the
        // level+full pair the v0.9.369 UIs wrote, so nobody's choice resets.
        // 0=off 1=silhouette 2=full 3=xBR 4=xBRZ.
        private static int ResolveSpriteSmoothingMode()
        {
            var profile = ProfileManager.CurrentProfile;
            if (profile == null)
            {
                return 0;
            }

            int mode = profile.SpriteSmoothingMode;
            if (mode < 0)
            {
                mode = profile.SpriteSmoothingLevel <= 0 ? 0 : (profile.SpriteSmoothingFull ? 2 : 1);
            }

            return System.Math.Clamp(mode, 0, 4);
        }

        public override bool Draw(UltimaBatcher2D batcher, RenderTargets renderTargets)
        {
            if (!_world.InGame)
            {
                return false;
            }

            // --- Facet swap instrumentation (R1) ---
            // First Draw with InGame=true post-swap marks the moment the
            // user actually sees the new world. JS side hides the
            // crossfade overlay on this signal (or earlier on the 100ms
            // hard-cap timeout, whichever comes first).
            _world.NotifyFirstDrawAfterSwap();

            if (CheckDeathScreen(batcher))
            {
                return true;
            }

            Viewport r_viewport = batcher.GraphicsDevice.Viewport;
            Viewport camera_viewport = Camera.GetViewport();
            Matrix matrix = Camera.ViewTransformMatrix;

            // Upscaler modes (task #163): when the player picked xBR/xBRZ, the
            // world renders at NATIVE resolution (zoom stripped from the
            // matrix, RTs shrunk by WorldScale) and RenderTargets.Draw routes
            // it through the upscaler. Magnified (>1x): one direct upscaler
            // blit. Default 1:1 (the common case, operator 2026-07-10 "una
            // estrategia real, aunque sea gastando GPU"): xBRZ into a 2× RT +
            // linear downscale — supersampled edge reconstruction. Zoomed OUT
            // (<1x) there is nothing to reconstruct: shipped pipeline, like
            // modes 0-2.
            int smoothMode = ResolveSpriteSmoothingMode();
            float contentScale = Camera.ContentScale;
            bool upscalerActive = smoothMode >= 3 && contentScale > 0.99f;
            renderTargets.UpscaleMode = upscalerActive
                ? (smoothMode == 4 ? RenderTargets.UPSCALE_XBRZ : RenderTargets.UPSCALE_XBR)
                : RenderTargets.UPSCALE_NONE;
            renderTargets.WorldScale = upscalerActive ? Math.Min(1f, 1f / contentScale) : 1f;
            if (upscalerActive)
            {
                // The RTs themselves shrink (WorldScale) and FNA resets the
                // viewport to the bound RT's size on SetRenderTarget, so only
                // the matrix changes here — camera_viewport stays full-size
                // for every non-RT pass.
                matrix = Camera.ViewTransformMatrixNoZoom;
            }

            bool can_draw_lights = false;

#if BROWSER_WASM
            // v0.3.36 lag-diag (extended): Update path showed only AnimStatics
            // hitting >5 ms (4 events in 46 s) yet 33 of 37 long-frames had
            // NO labelled subsystem responsible. The remaining lag is in
            // Draw or in `base.Draw` (which dispatches UIManager paint).
            // Reuse the same _lagSw/_lagDiagLastLog with the same 500 ms
            // cooldown per label.
            _lagSw.Restart();
#endif

            can_draw_lights = PrepareLightsRendering(batcher, ref matrix, renderTargets);
#if BROWSER_WASM
            LagCheckpoint("PrepareLights");
#endif
            batcher.GraphicsDevice.Viewport = camera_viewport;

            DrawWorld(batcher, ref matrix, renderTargets);
#if BROWSER_WASM
            LagCheckpoint("DrawWorld");
#endif

            batcher.GraphicsDevice.Viewport = r_viewport;

            bool res = base.Draw(batcher, renderTargets);
#if BROWSER_WASM
            LagCheckpoint("base.Draw");
            // v0.4.48: anchor end-of-Draw wallclock for the long-frame
            // breakdown. The browser-side gap (GPU commit + compositor +
            // rAF dispatch back) is the wallclock interval between this
            // point and the start of the next Update.
            GameController.WasmDrawEndMs = Environment.TickCount64;
#endif
            return res;
        }

        private void DrawWorld(UltimaBatcher2D batcher, ref Matrix matrix, RenderTargets renderTargets)
        {
#if BROWSER_WASM
            // v0.3.38: drill-down into DrawWorld. Operator log v0.3.37 in
            // Green Acres showed DrawWorld taking 27-42 ms EVERY frame
            // (the 833 ms cadence in earlier logs was just wallclock
            // sampling of long-frames at ~30 fps). Splitting into:
            // SetRT, FillObj, RenderLists, DrawTail to find the dominant
            // sub-step.
            _lagSw.Restart();
#endif
            // 2026-04-26: wasm now binds the WorldRT same as desktop —
            // see -DMOJOSHADER_FLIP_RENDERTARGET in
            // wasm-fna-native-mercury.targets._FnaCompileFlags for the
            // root cause of the prior FBO-no-op symptom.
            batcher.GraphicsDevice.SetRenderTarget(renderTargets.WorldRenderTarget);
#if BROWSER_WASM
            LagCheckpoint("Draw.SetRT");
#endif
            SelectedObject.Object = null;
            Profiler.EnterContext(Profiler.ProfilerContext.RENDER_FRAME_WORLD_PREPARE);
            FillGameObjectList();
#if BROWSER_WASM
            LagCheckpoint("Draw.FillObj");
            // v0.4.20: keep the latest fill-pass result in static fields so
            // [click-recv] can dump the previous frame's snapshot, but no
            // longer log per-frame — the diagnosis (FrameInfo alpha-frame
            // race) is done and per-frame logs flooded the console.
            {
                var _so = SelectedObject.Object;
                GameController._lastFillEndKind = _so switch {
                    Mobile mb => $"Mobile(0x{mb.Serial:X8})",
                    Item it => $"Item(0x{it.Serial:X8})",
                    Static st => $"Static(0x{st.Graphic:X4})",
                    Land ld => $"Land(0x{ld.Graphic:X4})",
                    Multi mt => $"Multi(0x{mt.Graphic:X4})",
                    null => "null",
                    _ => _so.GetType().Name,
                };
                GameController._lastFillEndTick = (uint)Time.Ticks;
            }
#endif

            // Restore previous highlight's original hue before applying new one
            if (_prevMeshHighlight != null
                && !_prevMeshHighlight.IsDestroyed
                && _prevMeshHighlight.InChunkMesh
                && _prevMeshHighlight.MeshSpriteIndex >= 0)
            {
                var prevChunk = _world.Map.GetChunk(_prevMeshHighlight.X, _prevMeshHighlight.Y);
                if (prevChunk?.Mesh != null)
                {
                    var prevLayer = _prevMeshHighlight is Land ? prevChunk.Mesh.Land : prevChunk.Mesh.Statics;
                    ApplyMeshHue(_prevMeshHighlight, prevLayer);
                }
            }
            _prevMeshHighlight = null;

            // Apply highlight hue to mesh vertex for selected meshed object
            // (instead of redrawing it on top, which breaks z-order for overlapping objects)
            if (ProfileManager.CurrentProfile.HighlightGameObjects
                && SelectedObject.Object is GameObject selObj
                && selObj.InChunkMesh && selObj.MeshSpriteIndex >= 0)
            {
                var chunk = _world.Map.GetChunk(selObj.X, selObj.Y);
                if (chunk?.Mesh != null)
                {
                    var layer = selObj is Land ? chunk.Mesh.Land : chunk.Mesh.Statics;
                    float shaderType = selObj is Land land && land.IsStretched
                        ? ShaderHueTranslator.SHADER_LAND_HUED
                        : ShaderHueTranslator.SHADER_HUED;
                    layer.SetHue(
                        selObj.MeshSpriteIndex,
                        Constants.HIGHLIGHT_CURRENT_OBJECT_HUE - 1,
                        shaderType
                    );
                    _prevMeshHighlight = selObj;
                }
            }

            Profiler.ExitContext(Profiler.ProfilerContext.RENDER_FRAME_WORLD_PREPARE);
            Profiler.EnterContext(Profiler.ProfilerContext.RENDER_FRAME_WORLD);
            batcher.SetSampler(SamplerState.PointClamp);

            batcher.Begin(null, matrix);
            batcher.SetBrightlight(ProfileManager.CurrentProfile.TerrainShadowsLevel * 0.1f);
            // Sprite smoothing (texel-AA) from the video options — hot-applied
            // every frame so the slider takes effect instantly. The shader
            // gates gumps/text itself; UI passes stay crisp with no reset here.
            // Modes 3/4 (xBR/xBRZ) turn the in-shader texel-AA OFF — the
            // upscaler at the blit replaces it.
            {
                int _sm = ResolveSpriteSmoothingMode();
                batcher.SetSpriteSmoothing(
                    ProfileManager.CurrentProfile.SpriteSmoothingLevel * 0.01f,
                    (_sm == 1 || _sm == 2) ? _sm : 0);
            }
            // 2026-04-26: GlobalLight uniform stays at 1.0 (its shader
            // default). The proper day/night darkness is applied by the
            // LightRT multiplicative composite (Zero / SourceColor blend
            // in RenderTargets.Draw). The earlier wasm-only
            // SetGlobalLight(IsometricLevel) was a workaround for the
            // FBO-no-op symptom; with MOJOSHADER_FLIP_RENDERTARGET in
            // place the LightRT pipeline matches desktop and feeding
            // IsometricLevel here would double-darken (world * mask *
            // mask). Leave the uniform alone.

            if (ProfileManager.CurrentProfile.UseCircleOfTransparency
                && ProfileManager.CurrentProfile.CircleOfTransparencyType != 1) // gradient mode uses CPU alpha, not shader
            {
                batcher.SetCircleOfTransparencyRadius(
                    (float)ProfileManager.CurrentProfile.CircleOfTransparencyRadius / Camera.Zoom
                );
            }
            else
            {
                batcher.SetCircleOfTransparencyRadius(0f);
            }

            // https://shawnhargreaves.com/blog/depth-sorting-alpha-blended-objects.html
            batcher.SetStencil(DepthStencilState.Default);

#if BROWSER_WASM
            LagCheckpoint("Draw.PreRenderLists");
#endif
            RenderedObjectsCount = _renderLists.DrawRenderLists(
                batcher,
                _maxGroundZ,
                _visibleChunks,
                _offset.X,
                _offset.Y
            );
#if BROWSER_WASM
            LagCheckpoint("Draw.RenderLists");
#endif


            if (
                _multi != null
                && _world.TargetManager.IsTargeting
                && _world.TargetManager.TargetingState == CursorTarget.MultiPlacement
            )
            {
                _multi.Draw(
                    batcher,
                    _multi.RealScreenPosition.X,
                    _multi.RealScreenPosition.Y,
                    _multi.CalculateDepthZ()
                );
            }

            // draw weather
            _world.Weather.Draw(batcher, 0, 0, MAX_LAYER_DEPTH - 1);

            DrawSelection(batcher, MAX_LAYER_DEPTH);

            batcher.SetSampler(null);
            batcher.SetStencil(null);
            batcher.SetCircleOfTransparencyRadius(0f);
            // GlobalLight stays at its shader default of 1.0 — see the
            // matching comment at the start of the world pass.
            batcher.End();

            int flushes = batcher.FlushesDone;
            int switches = batcher.TextureSwitches;
#if !BROWSER_WASM
            batcher.GraphicsDevice.SetRenderTarget(null);
#endif
            Profiler.ExitContext(Profiler.ProfilerContext.RENDER_FRAME_WORLD);
        }

        private bool PrepareLightsRendering(UltimaBatcher2D batcher, ref Matrix matrix, RenderTargets renderTargets)
        {
#if BROWSER_WASM
            // v0.4.11 lights-diag: sample _lightCount AT THE TOP, BEFORE
            // any clearing or drawing. This captures the value left by
            // the previous frame's PathA + PathB AddLight calls. Per-path
            // counters are accumulated within each frame in AddLight and
            // sampled here as well (then reset for the next frame).
            //
            // What we look for in the dump:
            //   - count varies frame-to-frame   → some path is dropping
            //                                      lights intermittently
            //   - count > 100 (MAX_LIGHTS cap)  → my v0.4.10 _lightCount
            //                                      preservation lets PathB
            //                                      grow it past the cap;
            //                                      AddLight then returns
            //                                      early on new entries
            //   - cache hits > 0                → my v0.4.10 fix matters
            //   - alphaChanged = misses         → cache always invalidated
            //                                      every frame; my fix is
            //                                      a no-op
            int countAtTop = _lightCount;
            if (countAtTop < _lightDiagCountMin) _lightDiagCountMin = countAtTop;
            if (countAtTop > _lightDiagCountMax) _lightDiagCountMax = countAtTop;
            _lightDiagCountSum += countAtTop;
            int pathA = _lightDiagPathACountThisFrame;
            int pathB = _lightDiagPathBCountThisFrame;
            if (pathA < _lightDiagPathAMin) _lightDiagPathAMin = pathA;
            if (pathA > _lightDiagPathAMax) _lightDiagPathAMax = pathA;
            if (pathB < _lightDiagPathBMin) _lightDiagPathBMin = pathB;
            if (pathB > _lightDiagPathBMax) _lightDiagPathBMax = pathB;
            _lightDiagPathACountThisFrame = 0;
            _lightDiagPathBCountThisFrame = 0;
            _lightDiagFrameIdx++;
            if (_lightDiagFrameIdx >= 60)
            {
                int n = _lightDiagFrameIdx;
                int hits = _lightDiagCacheHits;
                int misses = _lightDiagCacheMisses;
                long avg = n > 0 ? _lightDiagCountSum / n : 0;
                Console.WriteLine(
                    $"[lights-diag] last{n} frames: count min={_lightDiagCountMin} max={_lightDiagCountMax} avg={avg} | " +
                    $"pathA min={_lightDiagPathAMin} max={_lightDiagPathAMax} | " +
                    $"pathB min={_lightDiagPathBMin} max={_lightDiagPathBMax} | " +
                    $"cache hits={hits} misses={misses} | " +
                    $"alphaChangedFrames={_lightDiagAlphaChangedFrames} | " +
                    $"MAX_LIGHTS={LightsLoader.MAX_LIGHTS_DATA_INDEX_COUNT}"
                );
                _lightDiagFrameIdx = 0;
                _lightDiagCacheHits = 0;
                _lightDiagCacheMisses = 0;
                _lightDiagCountMin = int.MaxValue;
                _lightDiagCountMax = int.MinValue;
                _lightDiagCountSum = 0;
                _lightDiagPathAMin = int.MaxValue;
                _lightDiagPathAMax = int.MinValue;
                _lightDiagPathBMin = int.MaxValue;
                _lightDiagPathBMax = int.MinValue;
                _lightDiagAlphaChangedFrames = 0;
            }
#endif

            InitializeRenderTargets(renderTargets);

            // 2026-04-26: wasm runs the full light pass like desktop
            // now — the FBO no-op symptom was the missing
            // -DMOJOSHADER_FLIP_RENDERTARGET in the wasm FNA3D /
            // MojoShader compile flags (see
            // wasm-fna-native-mercury.targets._FnaCompileFlags).

            if (
                !UseLights && !UseAltLights
                || _world.Player.IsDead && ProfileManager.CurrentProfile.EnableBlackWhiteEffect
            )
            {
                batcher.GraphicsDevice.SetRenderTarget(renderTargets.LightRenderTarget);
                batcher.GraphicsDevice.Clear(ClearOptions.Target, Color.Transparent, 0f, 0);
                batcher.GraphicsDevice.SetRenderTarget(null);

                return false;
            }

            batcher.GraphicsDevice.SetRenderTarget(renderTargets.LightRenderTarget);
            batcher.GraphicsDevice.Clear(ClearOptions.Target, Color.Black, 0f, 0);

            if (!UseAltLights)
            {
                float lightColor = _world.Light.IsometricLevel;

                if (ProfileManager.CurrentProfile.UseDarkNights)
                {
                    lightColor -= 0.04f;
                }

                batcher.GraphicsDevice.Clear(
                    ClearOptions.Target,
                    new Vector4(lightColor, lightColor, lightColor, 1),
                    0f,
                    0
                );
            }

            batcher.Begin(null, matrix);
            batcher.SetBlendState(BlendState.Additive);

            Vector3 hue = Vector3.Zero;

            hue.Z = 1f;

            for (int i = 0; i < _lightCount; i++)
            {
                ref LightData l = ref _lights[i];
                ref readonly var lightInfo = ref Client.Game.UO.Lights.GetLight(l.ID);

                if (lightInfo.Texture == null)
                {
                    continue;
                }

                hue.X = l.Color;
                hue.Y =
                    hue.X > 1.0f
                        ? l.IsHue
                            ? ShaderHueTranslator.SHADER_HUED
                            : ShaderHueTranslator.SHADER_LIGHTS
                        : ShaderHueTranslator.SHADER_NONE;

                batcher.Draw(
                    lightInfo.Texture,
                    new Vector2(
                        l.DrawX - lightInfo.UV.Width * 0.5f,
                        l.DrawY - lightInfo.UV.Height * 0.5f
                    ),
                    lightInfo.UV,
                    hue,
                    0f
                );
            }

            // v0.4.10: on WASM the reset happens in FillGameObjectList
            // after the idle-skip cache check (so cache-hit frames keep
            // last fill's light data). On non-WASM there is no idle-skip
            // cache, so the reset must still happen here — otherwise
            // _lightCount grows unbounded across frames and AddLight
            // starts returning early at MAX_LIGHTS. v0.4.11 restores
            // the desktop reset that v0.4.10 accidentally removed.
#if !BROWSER_WASM
            _lightCount = 0;
#endif

            batcher.SetBlendState(null);
            batcher.End();

            batcher.GraphicsDevice.SetRenderTarget(null);

            return true;
        }

        private void InitializeRenderTargets(RenderTargets renderTargets)
        {
            renderTargets.SetLightsConfiguration(
                UseAltLights ? _altLightsBlend : (UseLights ? _darknessBlend : () => null),
                () =>
                {
                    Vector3 v = Vector3.Zero;
                    v.Z = UseAltLights ? 0.5f : 1f;
                    return v;
                }
            );
        }

        public override void DrawUI(UltimaBatcher2D batcher)
        {
            _healthLinesManager.Draw(batcher, 0f);

            if (!UIManager.IsMouseOverWorld)
            {
                SelectedObject.Object = null;
            }

            _world.WorldTextManager.ProcessWorldText(true);
            _world.WorldTextManager.Draw(batcher, Camera.Bounds.X, Camera.Bounds.Y, 0);
#if BROWSER_WASM
            // v0.4.20: same pattern as fill-end — keep the snapshot for
            // [click-recv] but stop logging per-frame.
            {
                var _so = SelectedObject.Object;
                GameController._lastDrawUiEndKind = _so switch {
                    Mobile mb => $"Mobile(0x{mb.Serial:X8})",
                    Item it => $"Item(0x{it.Serial:X8})",
                    Static st => $"Static(0x{st.Graphic:X4})",
                    Land ld => $"Land(0x{ld.Graphic:X4})",
                    Multi mt => $"Multi(0x{mt.Graphic:X4})",
                    TextObject txt => $"TextObject(owner={(txt.Owner is Entity e ? $"0x{e.Serial:X8}" : "non-entity")})",
                    null => "null",
                    _ => _so.GetType().Name,
                };
                GameController._lastDrawUiEndTick = (uint)Time.Ticks;
            }
#endif
        }

        public void DrawSelection(UltimaBatcher2D batcher, float layerDepth)
        {
            if (_isSelectionActive)
            {
                Vector3 selectionHue = new()
                {
                    Z = 0.7f
                };

                Point upperLeftInWorld = Camera.ScreenToWorld(new Point(
                    Math.Min(_selectionStart.X, Mouse.Position.X) - Camera.Bounds.X,
                    Math.Min(_selectionStart.Y, Mouse.Position.Y) - Camera.Bounds.Y
                ));

                Point lowerRightInWorld = Camera.ScreenToWorld(new Point(
                    Math.Max(_selectionStart.X, Mouse.Position.X) - Camera.Bounds.X,
                    Math.Max(_selectionStart.Y, Mouse.Position.Y) - Camera.Bounds.Y
                ));

                Rectangle selectionRect = new Rectangle(
                    upperLeftInWorld.X,
                    upperLeftInWorld.Y,
                    lowerRightInWorld.X - upperLeftInWorld.X,
                    lowerRightInWorld.Y - upperLeftInWorld.Y
                );

                batcher.Draw(
                    SolidColorTextureCache.GetTexture(Color.Black),
                    selectionRect,
                    selectionHue,
                    layerDepth
                );

                selectionHue.Z = 0.3f;

                batcher.DrawRectangle(
                    SolidColorTextureCache.GetTexture(Color.DeepSkyBlue),
                    selectionRect.X,
                    selectionRect.Y,
                    selectionRect.Width,
                    selectionRect.Height,
                    selectionHue,
                    layerDepth
                );
            }
        }

        private static readonly RenderedText _youAreDeadText = RenderedText.Create(
            ResGeneral.YouAreDead,
            0xFFFF,
            3,
            false,
            FontStyle.BlackBorder,
            TEXT_ALIGN_TYPE.TS_LEFT
        );

        private bool CheckDeathScreen(UltimaBatcher2D batcher)
        {
            if (
                ProfileManager.CurrentProfile != null
                && ProfileManager.CurrentProfile.EnableDeathScreen
            )
            {
                if (_world.InGame)
                {
                    if (_world.Player.IsDead && _world.Player.DeathScreenTimer > Time.Ticks)
                    {
                        batcher.Begin();
                        _youAreDeadText.Draw(
                            batcher,
                            Camera.Bounds.X + (Camera.Bounds.Width / 2 - _youAreDeadText.Width / 2),
                            Camera.Bounds.Bottom / 2,
                            0f
                        );
                        batcher.End();

                        return true;
                    }
                }
            }

            return false;
        }

        private void StopFollowing()
        {
            if (_followingMode)
            {
                _followingMode = false;
                _followingTarget = 0;
                _world.Player.Pathfinder.StopAutoWalk();

                _world.MessageManager.HandleMessage(
                    _world.Player,
                    ResGeneral.StoppedFollowing,
                    string.Empty,
                    0,
                    MessageType.Regular,
                    3,
                    TextType.CLIENT
                );
            }
        }

        private struct LightData
        {
            public byte ID;
            public ushort Color;
            public bool IsHue;
            public int DrawX,
                DrawY;
        }
    }
}
