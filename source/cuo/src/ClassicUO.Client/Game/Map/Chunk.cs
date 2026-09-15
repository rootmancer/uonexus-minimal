// SPDX-License-Identifier: BSD-2-Clause

using System.Collections.Generic;
using System.Runtime.CompilerServices;
using ClassicUO.Game.GameObjects;
using ClassicUO.Game.Managers;
using ClassicUO.Assets;
using ClassicUO.Utility;
using System;
using System.Runtime.InteropServices;
using System.Buffers;

namespace ClassicUO.Game.Map
{
    internal sealed class Chunk
    {
        private static readonly Queue<Chunk> _pool = new Queue<Chunk>();

        private readonly World _world;

        public Chunk(World world)
        {
            _world = world;
        }

        public GameObject[,] Tiles { get; } = new GameObject[8, 8];
        public bool IsDestroyed;
        public long LastAccessTime;
        public LinkedListNode<int> Node;
        public readonly ChunkMesh Mesh = new ChunkMesh();

        public int X;
        public int Y;
#if BROWSER_WASM
        // v0.5.17 R3: set false when LoadLandOnly runs (deferred statics),
        // true when LoadStaticsOnly or the full Load() completes. Used by
        // the statics-catchup pass in GameScene.FillGameObjectList to know
        // which chunks still need their statics stream from IDBFS.
        public bool StaticsLoaded;
        // v0.9.371 snap-guard: true ONLY when this chunk's statics came from
        // a complete StaticFile (MUL) read in THIS session. LoadFromSnapshot
        // leaves it false. Snapshot capture (SaveSnapshotToMap) requires it,
        // which closes the generational-decay hole behind the operator's
        // recurring ghost-statics reports: a chunk hydrated from a snapshot
        // used to RE-capture on Destroy, re-stamping FileStaticCount from the
        // live staidx — so any content-level poison (statics missing while
        // the index count matched) self-perpetuated past the v0.8.93
        // validation forever. Hydrated chunks now skip re-capture entirely;
        // their snapshot (already in the cache) simply survives untouched.
        // Also left false on a short/failed StaticFile read (ArrayPool rents
        // dirty buffers — a short read leaves garbage in the span tail) and
        // on the !IsValid early-out, so those states can never be captured.
        public bool StaticsFromFile;

        // v1.0.17 capture-guard: how many Statics the MUL read actually INSERTED into this chunk.
        //
        // 🚨 THE FOURTH POISON VECTOR. StaticsFromFile says the READ was complete; it says nothing
        // about the chunk's life afterwards. SaveSnapshotToMap walks the LIVE tile lists and skips
        // anything destroyed, so a Static removed between load and eviction (Static.Destroy,
        // Map.ClearUnusedBlocks after CLEAR_TEXTURES_DELAY) is simply absent from the payload — and
        // the snapshot is written anyway, PARTIAL, passing every existing check: StaticsFromFile is
        // true, the count is not zero so the poison probe never runs (it only tests == 0), and
        // FileStaticCount still matches the live index at load. Operator, 2026-08-21: walls missing
        // in one district, fine after clearing the cache, broken again in the next district —
        // captured and re-hydrated inside a SINGLE session. `?snapshot=off` makes it disappear.
        //
        // ⚠️ COMPARING AGAINST THE FILE INDEX WOULD BE WRONG, and it is the obvious fix. The load
        // skips entries with Color 0 or 0xFFFF, so payload < FileStaticCount is NORMAL — a strict
        // inequality there would refuse every capture and silently turn the cache off. This counts
        // what WE inserted, so the comparison is exact and has no legitimate false positive.
        public int StaticsInsertedFromFile;
#endif

#if BROWSER_WASM
        // v0.4.58: high-watermark of any object Z added to this chunk.
        // Used by GameScene.FillGameObjectList to skip chunks whose entire
        // content sits below the player's render band at high altitude
        // (operator z=100 runmatch over forest case). Never decremented on
        // RemoveGameObject — keeping it as a high watermark gives false
        // negatives only (chunk rendered when it could be skipped), which
        // is safe. The watermark drops back to sbyte.MinValue only on
        // Reset (chunk return-to-pool).
        public sbyte MaxContentZ = sbyte.MinValue;
#endif

#if BROWSER_WASM
        // v0.4.51: per-chunk cache of last iteration's contributions, so
        // that on a cache-MISS frame where this chunk is STABLE (was in
        // viewport last fill) and CLEAN (mesh not dirty) and no alpha
        // tick fired, the chunk loop can SKIP the inner 8×8 × linked-list
        // walk entirely and just replay the cached contributions:
        //
        //   - CachedMeshContribs: objects that took the mesh fast path
        //     in AddTileToRenderList (Land/Static/Multi where InChunkMesh
        //     is true). Their mesh.Land/Statics visibility flags persist
        //     in the GPU buffer across frames, so on replay we only need
        //     to re-call TrySelectObject so hover/click stays accurate.
        //
        //   - CachedSlowPathContribs + CachedSlowPathTransparent: objects
        //     that PushToRenderQueue added to _renderLists (Items, Mobiles,
        //     animated/excluded Land + Statics). Their _renderLists entry
        //     was cleared at fill start, so on replay we re-add them with
        //     their cached `isTransparent` flag AND re-call TrySelectObject.
        //
        // CachedContribsValid is set true when full iteration populates the
        // lists; reset to false whenever the chunk is destroyed/returned
        // to pool. The mesh-dirty path naturally rebuilds because the
        // replay gate also requires `!mesh.IsDirty`.
        public bool CachedContribsValid;
        // 2026-09-15 (ported from the mini): the view the cache was CLIPPED under - draw offset and pixel
        // box of the fill that built it. A replay is only complete while today's visible area still sits
        // inside that box (see GameScene.ReplayClipCovers). Written when CachedContribsValid goes true.
        public int CachedClipOffX, CachedClipOffY;
        public float CachedClipMinX, CachedClipMinY, CachedClipMaxX, CachedClipMaxY, CachedClipZoom;
        // The draw offset EVERY object of this chunk had its screen position computed at, or int.MinValue
        // when that is not known. Positions go stale behind UpdateDrawPosition's back: a replay refreshes
        // only the cached objects, a walk stops a cell's chain at the first object outside the clip, and a
        // chunk the fill never visits keeps whatever offset it last saw - while UpdateDrawPosition is
        // cleared at the end of every fill. A full walk refreshes whole chains whenever this differs from
        // the current offset (AddTileToRenderList) and then stamps it.
        public int RspOffX = int.MinValue, RspOffY = int.MinValue;
        public readonly List<GameObject> CachedMeshContribs = new List<GameObject>();
        public readonly List<GameObject> CachedSlowPathContribs = new List<GameObject>();
        public readonly List<bool> CachedSlowPathTransparent = new List<bool>();
        // v0.4.52: light-source objects (Statics/Multis with IsLight) that
        // had AddLight called during the chunk loop's mesh fast-path or
        // ProcessStaticLikeTail. On chunk replay we MUST re-call AddLight
        // for each — otherwise Path A lights drop to zero on cache-replay
        // frames and torches/lanterns/etc. flicker once per tile-step.
        // Operator runmatch7.log post-v0.4.51 showed exactly that: lights-
        // diag `pathA min=0 max=7` (lights present on full-iteration frames,
        // absent on replay frames) with cache hits jumping from 0 to 35
        // per 60-frame window as the replay path kicked in.
        public readonly List<GameObject> CachedLightObjects = new List<GameObject>();
#endif


        public static Chunk Create(World world, int x, int y)
        {
            Chunk c;
            if (_pool.Count > 0)
            {
                c = _pool.Dequeue();
                c.IsDestroyed = false;
            }
            else
            {
                c = new Chunk(world);
            }

            c.LastAccessTime = Time.Ticks + Constants.CLEAR_TEXTURES_DELAY;
            c.X = x;
            c.Y = y;

            return c;
        }

        public static void ClearPool()
        {
            while (_pool.Count > 0)
            {
                var chunk = _pool.Dequeue();
                chunk.Mesh.Clear();
            }
        }


        // v0.5.17 R3: full load (land + statics) — used in non-burst paths
        // and as the combined entry point.
        public unsafe void Load(int index)
        {
            LoadLandOnly(index);
            LoadStaticsOnly(index);
        }

        // v0.5.17 R3: load only the 64 land tiles for this chunk. Fast:
        // reads one MapBlock (~64 bytes), no StaticFile I/O. Called during
        // the burst-fill of a teleport so the frame unblocks in ~5 ms
        // instead of ~100 ms. StaticsLoaded is left false; the catchup
        // pass in GameScene calls LoadStaticsOnly on subsequent fills.
        public unsafe void LoadLandOnly(int index)
        {
            IsDestroyed = false;
#if BROWSER_WASM
            StaticsLoaded = false;
            StaticsFromFile = false;
            StaticsInsertedFromFile = 0;
#endif
            Map map = _world.Map;

            ref var im = ref GetIndex(index);

            if (!im.IsValid())
            {
                return;
            }

            im.MapFile.Seek((long)im.MapAddress, System.IO.SeekOrigin.Begin);
            var block = im.MapFile.Read<MapBlock>();

            var cells = block.Cells;
            int bx = X << 3;
            int by = Y << 3;

            for (int y = 0; y < 8; ++y)
            {
                int pos = y << 3;
                ushort tileY = (ushort)(by + y);

                for (int x = 0; x < 8; ++x, ++pos)
                {
                    ushort tileID = (ushort)(cells[pos].TileID & 0x3FFF);

                    sbyte z = cells[pos].Z;

                    Land land = Land.Create(_world, tileID);

                    ushort tileX = (ushort)(bx + x);

#if BROWSER_WASM
                    // v0.5.24 (F3-prep): fast-path inline neighbour reads
                    // from currentBlock for interior tiles. Edge tiles fall
                    // back to map.GetTileZ inside ApplyStretchInChunk.
                    land.ApplyStretchInChunk(map, x, y, tileX, tileY, z, ref block);
#else
                    land.ApplyStretch(map, tileX, tileY, z);
#endif
                    land.X = tileX;
                    land.Y = tileY;
                    land.Z = z;
                    land.UpdateScreenPosition();

                    AddGameObject(land, x, y);
                }
            }
        }

        // v0.5.17 R3: load statics for this chunk if not already loaded.
        // Called by the catchup pass (up to STATICS_CATCHUP_PER_FILL per
        // fill) so IDBFS I/O is spread across frames instead of all at once.
        public unsafe void LoadStaticsOnly(int index)
        {
#if BROWSER_WASM
            if (StaticsLoaded) return;
#endif
            ref var im = ref GetIndex(index);

            if (!im.IsValid())
            {
#if BROWSER_WASM
                StaticsLoaded = true;
#endif
                return;
            }

            int bx = X << 3;
            int by = Y << 3;

#if BROWSER_WASM
            bool readComplete = true;
            int inserted = 0;
#endif
            if (im.StaticAddress != 0 && im.StaticCount > 0)
            {
                var staticsBlockBuffer = ArrayPool<StaticsBlock>.Shared.Rent((int)im.StaticCount);
                var staticsSpan = staticsBlockBuffer.AsSpan(0, (int)im.StaticCount);
                im.StaticFile.Seek((long)im.StaticAddress, System.IO.SeekOrigin.Begin);
                var staticsBytes = MemoryMarshal.AsBytes(staticsSpan);
                int bytesRead = im.StaticFile.Read(staticsBytes);

#if BROWSER_WASM
                // v0.9.371 snap-guard: Stream.Read may return short (truncated
                // statics.mul, transient FS hiccup). The rented buffer is NOT
                // zeroed, so the tail past bytesRead is garbage from a previous
                // rent — clamp iteration to whole entries actually read and
                // mark the chunk ineligible for snapshot capture.
                if (bytesRead < staticsBytes.Length)
                {
                    readComplete = false;
                    int wholeEntries = bytesRead > 0 ? bytesRead / sizeof(StaticsBlock) : 0;
                    staticsSpan = staticsSpan.Slice(0, Math.Min(wholeEntries, staticsSpan.Length));
                    Console.WriteLine($"[snap-guard] short statics read cx={X} cy={Y} got={bytesRead}B want={staticsBytes.Length}B — chunk not capture-eligible");
                }
#endif

                foreach (ref var sb in staticsSpan)
                {
                    if (sb.Color != 0 && sb.Color != 0xFFFF)
                    {
                        int pos = (sb.Y << 3) + sb.X;

                        if (pos >= 64)
                        {
                            continue;
                        }

                        Static staticObject = Static.Create(_world, sb.Color, sb.Hue, pos);
                        staticObject.X = (ushort)(bx + sb.X);
                        staticObject.Y = (ushort)(by + sb.Y);
                        staticObject.Z = sb.Z;
                        staticObject.UpdateScreenPosition();

                        AddGameObject(staticObject, sb.X, sb.Y);
                        inserted++;
                    }
                }

                ArrayPool<StaticsBlock>.Shared.Return(staticsBlockBuffer);
            }
#if BROWSER_WASM
            StaticsLoaded = true;
            StaticsFromFile = readComplete;
            StaticsInsertedFromFile = readComplete ? inserted : 0;
#endif
        }


        private ref IndexMap GetIndex(int map)
        {
            Client.Game.UO.FileManager.Maps.SanitizeMapIndex(ref map);

            return ref Client.Game.UO.FileManager.Maps.GetIndex(map, X, Y);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public GameObject GetHeadObject(int x, int y)
        {
            GameObject obj = Tiles[x, y];

            while (obj?.TPrevious != null)
            {
                obj = obj.TPrevious;
            }

            return obj;
        }

        public void AddGameObject(GameObject obj, int x, int y)
        {
            Mesh.MarkDirtyIfNeeded(obj);
#if BROWSER_WASM
            // v0.4.51: any arrival (Item, Mobile, Land, Static, ...) makes
            // the per-chunk replay cache stale. Mesh.MarkDirtyIfNeeded only
            // fires for Land/Static/Multi — Items and Mobiles arrive
            // silently with respect to the mesh, so the cache must be
            // invalidated separately. Next fill takes the full-iteration
            // path which clears + rebuilds the cache.
            CachedContribsValid = false;
            RspOffX = RspOffY = int.MinValue; // the arrival's screen position is not known to match
#endif
            obj.RemoveFromTile();

            short priorityZ = obj.Z;
            sbyte state = -1;

            ushort graphic = obj.Graphic;

            switch (obj)
            {
                case Land tile:

                    if (tile.IsStretched)
                    {
                        priorityZ = (short) (tile.AverageZ - 1);
                    }
                    else
                    {
                        priorityZ--;
                    }

                    priorityZ -= 1;

                    state = 0;

                    break;

                case Mobile _:
                    priorityZ++;

                    break;

                case Item item:

                    if (item.IsCorpse)
                    {
                        priorityZ++;

                        break;
                    }
                    else if (item.IsMulti)
                    {
                        graphic = item.MultiGraphic;
                    }

                    goto default;

                case GameEffect _:
                    priorityZ += 2;

                    break;

                case Multi m:

                    state = 1;

                    if ((m.State & CUSTOM_HOUSE_MULTI_OBJECT_FLAGS.CHMOF_GENERIC_INTERNAL) != 0)
                    {
                        priorityZ--;

                        break;
                    }

                    if ((m.State & CUSTOM_HOUSE_MULTI_OBJECT_FLAGS.CHMOF_PREVIEW) != 0)
                    {
                        state = 2;
                        priorityZ++;
                    }
                    //else if ((m.ItemData.Flags & TileFlag.StairRight) != 0)
                    //{
                    //    priorityZ++;
                    //}

                    //if (m.IsMovable)
                    //{
                    //    priorityZ += 1;
                    //}

                    goto default;

                default:
                    ref StaticTiles data = ref Client.Game.UO.FileManager.TileData.StaticData[graphic];

                    if (data.IsBackground)
                    {
                        priorityZ--;
                    }

                    //if (data.IsSurface)
                    //{
                    //    priorityZ--;
                    //}

                    if (data.Height != 0)
                    {
                        priorityZ++;
                    }

                    if (data.IsMultiMovable)
                    {
                        priorityZ++;
                    }

                    break;
            }

            obj.PriorityZ = priorityZ;

#if BROWSER_WASM
            // v0.4.58: maintain the chunk's MaxContentZ watermark. Only
            // raises — never lowers — so removal doesn't trigger a costly
            // full re-scan. A stale-high watermark only makes us iterate
            // a chunk we could have skipped (safe).
            if (obj.Z > MaxContentZ)
            {
                MaxContentZ = obj.Z;
            }
#endif

            if (Tiles[x, y] == null)
            {
                Tiles[x, y] = obj;
                obj.TPrevious = null;
                obj.TNext = null;

                return;
            }


            GameObject o = Tiles[x, y];

            if (o == obj)
            {
                if (o.Previous != null)
                {
                    o = (GameObject) o.Previous;
                }
                else if (o.Next != null)
                {
                    o = (GameObject) o.Next;
                }
                else
                {
                    return;
                }
            }

            while (o?.TPrevious != null)
            {
                o = o.TPrevious;
            }

            GameObject found = null;
            GameObject start = o;

            while (o != null)
            {
                int testPriorityZ = o.PriorityZ;

                if (testPriorityZ > priorityZ || testPriorityZ == priorityZ && (state == 0 || state == 1 && !(o is Land)))
                {
                    break;
                }

                found = o;
                o = o.TNext;
            }

            if (found != null)
            {
                obj.TPrevious = found;
                GameObject next = found.TNext;
                obj.TNext = next;
                found.TNext = obj;

                if (next != null)
                {
                    next.TPrevious = obj;
                }
            }
            else if (start != null)
            {
                obj.TNext = start;
                start.TPrevious = obj;
                obj.TPrevious = null;
            }
        }

        public void RemoveGameObject(GameObject obj, int x, int y)
        {
            Mesh.MarkDirtyIfNeeded(obj);
#if BROWSER_WASM
            // v0.4.51: any departure (Item, Mobile, ...) makes the per-
            // chunk replay cache stale; replay would re-add the just-
            // removed object to _renderLists. See AddGameObject for the
            // arrival side of the same gate.
            CachedContribsValid = false;
#endif
            ref GameObject firstNode = ref Tiles[x, y];

            if (firstNode == null || obj == null)
            {
                return;
            }

            if (firstNode == obj)
            {
                firstNode = obj.TNext;
            }

            if (obj.TNext != null)
            {
                obj.TNext.TPrevious = obj.TPrevious;
            }

            if (obj.TPrevious != null)
            {
                obj.TPrevious.TNext = obj.TNext;
            }

            obj.TPrevious = null;
            obj.TNext = null;
        }


        public void Destroy()
        {
#if BROWSER_WASM
            // v0.5.25 F1: snapshot MUL-derived Lands + StaticFile Statics into
            // the Map's persistent cache BEFORE we destroy them, so a future
            // revisit can restore without re-reading MapFile / StaticFile.
            // Only run if we actually have content (StaticsLoaded means full
            // load completed; partial state could be inconsistent).
            // v0.9.371 snap-guard: StaticsFromFile additionally requires the
            // statics to have come from a COMPLETE MUL read in this session.
            // Chunks hydrated from a snapshot no longer re-capture — their
            // snapshot is already in the cache and re-capturing it from
            // in-memory state was the generational-decay vector that let
            // content-level poison outlive the v0.8.93 validation.
            if (!IsDestroyed && StaticsLoaded && StaticsFromFile)
            {
                SaveSnapshotToMap();
            }
#endif

            for (int i = 0; i < 8; i++)
            {
                for (int j = 0; j < 8; j++)
                {
                    GameObject obj = Tiles[i, j];

                    if (obj == null)
                    {
                        continue;
                    }

                    GameObject first = GetHeadObject(i, j);

                    while (first != null)
                    {
                        GameObject next = first.TNext;

                        if (!ReferenceEquals(first, _world.Player))
                        {
                            first.Destroy();
                        }

                        first.TPrevious = null;
                        first.TNext = null;
                        first = next;
                    }

                    Tiles[i, j] = null;
                }
            }

            if (Node != null)
            {
                if (Node.Next != null || Node.Previous != null)
                {
                    Node.List?.Remove(Node);
                }

                Node = null;
            }

            IsDestroyed = true;

#if BROWSER_WASM
            // v0.5.17: reset staged-load flag on every pool return so the
            // next consumer of this slot starts with a clean state.
            StaticsLoaded = false;
            StaticsFromFile = false;
            StaticsInsertedFromFile = 0;
            // v0.4.51: drop replay caches when chunk leaves viewport or
            // is destroyed. Stale entries would resurrect freed items if
            // the chunk slot is later reused for a different (X,Y) tile.
            CachedContribsValid = false;
            RspOffX = RspOffY = int.MinValue;
            CachedMeshContribs.Clear();
            CachedSlowPathContribs.Clear();
            CachedSlowPathTransparent.Clear();
            CachedLightObjects.Clear();
            // v0.4.58: reset the MaxContentZ watermark so the pooled chunk
            // doesn't carry the previous slot's content height. Re-Load()
            // will repopulate via AddGameObject as objects are inserted.
            MaxContentZ = sbyte.MinValue;
#endif

            if (_pool.Count < Constants.PREDICTABLE_CHUNKS)
            {
                Mesh.SoftClear();
                _pool.Enqueue(this);
            }
            else
            {
                Mesh.Clear();
            }
        }

        public void Clear()
        {
            Destroy();
        }

        /// <summary>
        /// Clears the chunk's tile objects for an in-place reload (UltimaLive block
        /// update) and marks the mesh dirty so it rebuilds — WITHOUT destroying or
        /// pooling the chunk itself. Using <see cref="Destroy"/>/<see cref="Clear"/>
        /// here would enqueue this chunk to the shared pool while the map still
        /// references it, so <see cref="Create"/> would later hand it out for a
        /// different block (double ownership) — the original block then renders a
        /// stale/empty mesh (black, world-locked, permanent). Upstream ClassicUO
        /// 664bd36b7, ported 2026-07-20. Fork adaptation: the MUL-derived chunk
        /// SNAPSHOT is dropped too — UltimaLive just rewrote this block's map
        /// data, so the cached snapshot would seed rebuilds with stale tiles
        /// (the poisoned-snapshot class).
        /// </summary>
        public void ClearForReload()
        {
#if BROWSER_WASM
            _world.Map?.DropChunkSnapshot(X, Y);
#endif
            for (int i = 0; i < 8; i++)
            {
                for (int j = 0; j < 8; j++)
                {
                    GameObject first = GetHeadObject(i, j);

                    while (first != null)
                    {
                        GameObject next = first.TNext;

                        if (!ReferenceEquals(first, _world.Player))
                        {
                            first.Destroy();
                        }

                        first.TPrevious = null;
                        first.TNext = null;
                        first = next;
                    }

                    Tiles[i, j] = null;
                }
            }

            Mesh.SoftClear();
        }

        public bool HasNoExternalData()
        {
            for (int i = 0; i < 8; i++)
            {
                for (int j = 0; j < 8; j++)
                {
                    for (GameObject obj = GetHeadObject(i, j); obj != null; obj = obj.TNext)
                    {
                        if (!(obj is Land) && !(obj is Static) /*&& !(obj is Multi)*/)
                        {
                            return false;
                        }
                    }
                }
            }

            return true;
        }

#if BROWSER_WASM
        // v0.5.25 F1: walk Tiles, copy MUL-derived state (Lands + Statics) into
        // a ChunkSnapshot stored in Map._chunkSnapshots keyed by (X, Y). Items,
        // Mobiles, Multis, server-pushed dynamic Statics are skipped — they
        // stream from server and shouldn't outlive the chunk's life-cycle.
        private void SaveSnapshotToMap()
        {
            if (!ChunkSnapshot.Enabled) return;   // v0.8.94 ?snapshot=off — skip the capture walk too
            Map map = _world.Map;
            if (map == null) return;

            // Reuse an existing snapshot object if we have one (avoids alloc).
            if (!map.TryGetChunkSnapshot(X, Y, out ChunkSnapshot snap))
            {
                snap = new ChunkSnapshot();
            }

            int staticsCount = 0;
            int bx = X << 3;
            int by = Y << 3;

            for (int ly = 0; ly < 8; ly++)
            {
                for (int lx = 0; lx < 8; lx++)
                {
                    GameObject head = GetHeadObject(lx, ly);
                    for (var obj = head; obj != null; obj = obj.TNext)
                    {
                        if (obj.IsDestroyed) continue;

                        if (obj is Land land)
                        {
                            int idx = (ly << 3) + lx;
                            ref var ls = ref snap.Lands[idx];
                            ls.Graphic = land.Graphic;
                            ls.Z = land.Z;
                            ls.IsStretched = land.IsStretched;
                            ls.AverageZ = land.AverageZ;
                            ls.MinZ = land.MinZ;
                            ls.YOffsets = land.YOffsets;
                            ls.NormalTop = land.NormalTop;
                            ls.NormalRight = land.NormalRight;
                            ls.NormalLeft = land.NormalLeft;
                            ls.NormalBottom = land.NormalBottom;
                        }
                        else if (obj is Static st)
                        {
                            // Only cache Statics that came from the StaticFile
                            // MUL (have local 0..7 coords within this chunk
                            // and aren't server-pushed dynamic content). The
                            // ItemData.IsAnimated/IsFoliage flags would still
                            // be applied at restore time via Static.Create.
                            snap.EnsureStaticsCapacity(staticsCount + 1);
                            ref var ss = ref snap.Statics[staticsCount++];
                            ss.Graphic = st.Graphic;
                            ss.Hue = st.Hue;
                            ss.LocalX = (byte)(st.X - bx);
                            ss.LocalY = (byte)(st.Y - by);
                            ss.Z = st.Z;
                        }
                        // Items, Mobiles, Multis, Effects: skip — server-streamed.
                    }
                }
            }

            snap.StaticsCount = staticsCount;
            // v0.8.93: stamp the authoritative staidx entry count at capture
            // time so hydration can self-validate (see LoadFromSnapshot).
            {
                ref var imCap = ref GetIndex(map.Index);
                snap.FileStaticCount = (imCap.IsValid() && imCap.StaticAddress != 0)
                    ? (int)imCap.StaticCount : 0;
            }
            // v1.0.17 capture-guard: REFUSE a payload that lost statics since the MUL read.
            // The walk above skips destroyed objects, so anything removed between load and
            // eviction is silently absent. Writing that produces a snapshot that is partial AND
            // passes every later check, which is precisely the ghost-walls report. Dropping the
            // capture costs one re-read of this chunk next visit; writing it costs the walls.
            if (staticsCount < StaticsInsertedFromFile)
            {
                Console.WriteLine($"[snap-capture-SKIP] cx={X} cy={Y} collected={staticsCount} loaded={StaticsInsertedFromFile} — statics lost since the MUL read, not capturing");
                ChunkSnapshot.CaptureSkippedLossy++;
                return;
            }
            map.SaveChunkSnapshot(X, Y, snap);
            ChunkSnapshot.CacheSavedChunks++;
        }

        // v0.5.25 F1: hydrate this Chunk from a persisted ChunkSnapshot. Skips
        // MapFile.Read + ApplyStretch (the dominant getChunk2 cost in v0.5.24)
        // AND StaticFile.Read + Static creation (the catchup-pass cost).
        // Called from Map.GetChunk2 when a snapshot is available.
        // v0.8.89 instrumentation: cross-session OPFS snapshots are the one
        // path that can mark StaticsLoaded=true WITHOUT reading the (now
        // integrity-verified) StaticFile. A snapshot persisted by an old
        // session that ran on a truncated/corrupt statics .mul would bake
        // missing statics into the cache FOREVER — the catchup pass can never
        // repair it because the flag claims the chunk is complete. These
        // counters + the SUSPECT trace below prove/disprove that theory from
        // the operator's console log.
        public static long SnapHydrated;
        public static long SnapHydratedZeroStatics;
        public static long SnapHydratedSuspect;
        // v0.8.93: snapshots rejected because their capture-time staidx count
        // no longer matches the live file (stale/poisoned) — re-read from MUL.
        public static long SnapRejectedStale;

        public void LoadFromSnapshot(ChunkSnapshot snap, int mapIndex)
        {
            // v0.8.93 self-validation — ROOT FIX for the operator's persistent
            // missing-walls bug (tile(1479,1608): chunk hydrated with
            // StaticsLoaded=true yet 0 of the 3 statics statics0.mul holds
            // there). A snapshot persisted by an old session can bake an
            // incomplete chunk into OPFS forever, because hydration was the
            // one path that marked the chunk statics-complete WITHOUT reading
            // the (now integrity-verified) StaticFile. Validate the snapshot's
            // capture-time staidx entry count against the LIVE index (pure
            // in-memory read); on mismatch, drop the snapshot and load the
            // chunk from the MUL — which also re-captures a clean snapshot on
            // the chunk's next eviction. Schema v2 bump invalidates every
            // pre-fix persisted snapshot wholesale.
            {
                ref var imV = ref GetIndex(mapIndex);
                int liveCount = (imV.IsValid() && imV.StaticAddress != 0) ? (int)imV.StaticCount : 0;
                if (snap.FileStaticCount != liveCount)
                {
                    SnapRejectedStale++;
                    if (SnapRejectedStale <= 8)
                    {
                        Console.WriteLine($"[snap-stale] cx={X} cy={Y} capturedCount={snap.FileStaticCount} liveCount={liveCount} — rejecting snapshot, re-reading MUL");
                    }
                    Load(mapIndex);
                    return;
                }
            }

            IsDestroyed = false;
            StaticsLoaded = true; // snapshot includes statics
            StaticsFromFile = false;
            StaticsInsertedFromFile = 0; // hydrated, not MUL-read — not capture-eligible

            SnapHydrated++;
            if (snap.StaticsCount == 0)
            {
                SnapHydratedZeroStatics++;
                // Zero statics hydrated but the authoritative staidx entry says
                // this block HAS static entries (>4 filters legit all-nodraw
                // blocks): poisoned-snapshot smoking gun. Index read is just
                // the in-memory IndexMap struct — no file I/O.
                ref var imChk = ref GetIndex(mapIndex);
                if (imChk.IsValid() && imChk.StaticAddress != 0 && imChk.StaticCount > 4)
                {
                    SnapHydratedSuspect++;
                    Console.WriteLine($"[snap-hydrate-SUSPECT] cx={X} cy={Y} snapStatics=0 fileStatics={imChk.StaticCount}");
                }
            }

            int bx = X << 3;
            int by = Y << 3;
            Map map = _world.Map;

            // Restore Lands (64, one per tile cell)
            for (int ly = 0; ly < 8; ly++)
            {
                for (int lx = 0; lx < 8; lx++)
                {
                    int idx = (ly << 3) + lx;
                    ref var ls = ref snap.Lands[idx];
                    if (ls.Graphic == 0 && ls.Z == 0)
                    {
                        // Likely uninitialised snapshot slot (sea bed). Still
                        // create a Land with graphic 0 so render path is happy.
                    }
                    Land land = Land.Create(_world, ls.Graphic);
                    land.X = (ushort)(bx + lx);
                    land.Y = (ushort)(by + ly);
                    land.Z = ls.Z;
                    land.IsStretched = ls.IsStretched;
                    land.AverageZ = ls.AverageZ;
                    land.MinZ = ls.MinZ;
                    land.YOffsets = ls.YOffsets;
                    land.NormalTop = ls.NormalTop;
                    land.NormalRight = ls.NormalRight;
                    land.NormalLeft = ls.NormalLeft;
                    land.NormalBottom = ls.NormalBottom;
                    land.UpdateScreenPosition();
                    AddGameObject(land, lx, ly);
                }
            }

            // Restore Statics
            for (int i = 0; i < snap.StaticsCount; i++)
            {
                ref var ss = ref snap.Statics[i];
                int pos = (ss.LocalY << 3) + ss.LocalX;
                if (pos >= 64) continue;
                Static st = Static.Create(_world, ss.Graphic, ss.Hue, pos);
                st.X = (ushort)(bx + ss.LocalX);
                st.Y = (ushort)(by + ss.LocalY);
                st.Z = ss.Z;
                st.UpdateScreenPosition();
                AddGameObject(st, ss.LocalX, ss.LocalY);
            }

            snap.LastAccessTime = Time.Ticks;
            ChunkSnapshot.CacheHits++;
        }
#endif
    }
}