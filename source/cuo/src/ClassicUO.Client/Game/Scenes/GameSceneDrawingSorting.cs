// SPDX-License-Identifier: BSD-2-Clause

using System.Collections.Generic;
using ClassicUO.Assets;
using ClassicUO.Configuration;
using ClassicUO.Game.Data;
using ClassicUO.Game.GameObjects;
using ClassicUO.Game.Managers;
using ClassicUO.Game.Map;
using ClassicUO.Renderer;
using ClassicUO.Utility;
using Microsoft.Xna.Framework;
using System;
using System.Runtime.CompilerServices;

namespace ClassicUO.Game.Scenes
{
    internal partial class GameScene
    {
        private static GameObject[] _foliages = new GameObject[100];
        private static readonly TreeUnion[] _treeInfos =
        {
            new TreeUnion(0x0D45, 0x0D4C),
            new TreeUnion(0x0D5C, 0x0D62),
            new TreeUnion(0x0D73, 0x0D79),
            new TreeUnion(0x0D87, 0x0D8B),
            new TreeUnion(0x12BE, 0x12C7),
            new TreeUnion(0x0D4D, 0x0D53),
            new TreeUnion(0x0D63, 0x0D69),
            new TreeUnion(0x0D7A, 0x0D7F),
            new TreeUnion(0x0D8C, 0x0D90)
        };

        private sbyte _maxGroundZ;
        private int _maxZ;
        private Vector2 _minPixel,
            _maxPixel,
            _lastCamOffset;
        private bool _noDrawRoofs;
        private Point _offset,
            _maxTile,
            _minTile,
            _last_scaled_offset;

#if BROWSER_WASM
        // v0.4.97: expose the current draw-offset so non-render code (Mobile
        // step-commit) can force-refresh RealScreenPosition without waiting
        // for the next AddTileToRenderList visit. Operator log analysis on
        // v0.4.96 showed a consistent 27 ms / ~4-frame window after every
        // step commit where AddTileToRenderList did NOT visit the just-
        // moved mobile (cache-replay path skips, chunk iteration order, or
        // chunk-loop time-budget bail — root cause unimportant for the
        // fix). During those frames the renderer drew the sprite at the
        // OLD-tile RealScreenPosition + the freshly-reset Offset(0,0) ==
        // exactly one tile back. Forcing a same-frame refresh at commit
        // (Mobile.cs) closes that window. Read-only, never mutated outside
        // GetViewPort, so safe to expose.
        public Point DrawOffset => _offset;
#endif
        private int _oldPlayerX,
            _oldPlayerY,
            _oldPlayerZ;
        private int _foliageCount;
        private float _cotRadiusSq;
        private Vector2 _cotPlayerScreenPos;
        private bool _cotGradientMode;

        private readonly RenderLists _renderLists = new();
        private readonly List<Map.Chunk> _visibleChunks = new();

        public sbyte FoliageIndex { get; private set; }

        public void UpdateMaxDrawZ(bool force = false)
        {
            int playerX = _world.Player.X;
            int playerY = _world.Player.Y;
            int playerZ = _world.Player.Z;

            if (
                playerX == _oldPlayerX && playerY == _oldPlayerY && playerZ == _oldPlayerZ && !force
            )
            {
                return;
            }

            _oldPlayerX = playerX;
            _oldPlayerY = playerY;
            _oldPlayerZ = playerZ;

            sbyte maxGroundZ = 127;
            _maxGroundZ = 127;
            _maxZ = 127;
            _noDrawRoofs = !ProfileManager.CurrentProfile.DrawRoofs;
            int bx = playerX;
            int by = playerY;
            Chunk chunk = _world.Map.GetChunk(bx, by, false);

            if (chunk != null)
            {
                int x = playerX % 8;
                int y = playerY % 8;

                int pz14 = playerZ + 14;
                int pz16 = playerZ + 16;

                for (GameObject obj = chunk.GetHeadObject(x, y); obj != null; obj = obj.TNext)
                {
                    sbyte tileZ = obj.Z;

                    if (obj is Land l)
                    {
                        if (l.IsStretched)
                        {
                            tileZ = l.AverageZ;
                        }

                        if (pz16 <= tileZ)
                        {
                            maxGroundZ = (sbyte)pz16;
                            _maxGroundZ = (sbyte)pz16;
                            _maxZ = _maxGroundZ;

                            break;
                        }

                        continue;
                    }

                    if (obj is Mobile)
                    {
                        continue;
                    }

                    //if (obj is Item it && !it.ItemData.IsRoof || !(obj is Static) && !(obj is Multi))
                    //    continue;

                    if (tileZ > pz14 && _maxZ > tileZ)
                    {
                        ref StaticTiles itemdata = ref Client.Game.UO.FileManager.TileData.StaticData[
                            obj.Graphic
                        ];

                        //if (GameObjectHelper.TryGetStaticData(obj, out var itemdata) && ((ulong) itemdata.Flags & 0x20004) == 0 && (!itemdata.IsRoof || itemdata.IsSurface))
                        if (
                            ((ulong)itemdata.Flags & 0x20004) == 0
                            && (!itemdata.IsRoof || itemdata.IsSurface)
                        )
                        {
                            _maxZ = tileZ;
                            _noDrawRoofs = true;
                        }
                    }
                }

                int tempZ = _maxZ;
                _maxGroundZ = (sbyte)_maxZ;
                playerX++;
                playerY++;
                bx = playerX;
                by = playerY;
                chunk = _world.Map.GetChunk(bx, by, false);

                if (chunk != null)
                {
                    x = playerX % 8;
                    y = playerY % 8;

                    for (
                        GameObject obj2 = chunk.GetHeadObject(x, y);
                        obj2 != null;
                        obj2 = obj2.TNext
                    )
                    {
                        //if (obj is Item it && !it.ItemData.IsRoof || !(obj is Static) && !(obj is Multi))
                        //    continue;

                        if (obj2 is Mobile)
                        {
                            continue;
                        }

                        sbyte tileZ = obj2.Z;

                        if (tileZ > pz14 && _maxZ > tileZ)
                        {
                            if (!(obj2 is Land))
                            {
                                ref StaticTiles itemdata = ref Client.Game.UO.FileManager.TileData.StaticData[
                                    obj2.Graphic
                                ];

                                if (((ulong)itemdata.Flags & 0x204) == 0 && itemdata.IsRoof)
                                {
                                    _maxZ = tileZ;
                                    _world.Map.ClearBockAccess();
                                    _maxGroundZ = _world.Map.CalculateNearZ(
                                        tileZ,
                                        playerX,
                                        playerY,
                                        tileZ
                                    );
                                    _noDrawRoofs = true;
                                }
                            }

                            //if (GameObjectHelper.TryGetStaticData(obj2, out var itemdata) && ((ulong) itemdata.Flags & 0x204) == 0 && itemdata.IsRoof)
                            //{
                            //    _maxZ = tileZ;
                            //    World.Map.ClearBockAccess();
                            //    _maxGroundZ = World.Map.CalculateNearZ(tileZ, playerX, playerY, tileZ);
                            //    _noDrawRoofs = true;
                            //}
                        }
                    }

                    tempZ = _maxGroundZ;
                }

                _maxZ = _maxGroundZ;

                if (tempZ < pz16)
                {
                    _maxZ = pz16;
                    _maxGroundZ = (sbyte)pz16;
                }

                _maxGroundZ = maxGroundZ;
            }
        }

        private void IsFoliageUnion(ushort graphic, int x, int y, int z)
        {
            for (int i = 0; i < _treeInfos.Length; i++)
            {
                ref TreeUnion info = ref _treeInfos[i];

                if (info.Start <= graphic && graphic <= info.End)
                {
                    while (graphic > info.Start)
                    {
                        graphic--;
                        x--;
                        y++;
                    }

                    for (graphic = info.Start; graphic <= info.End; graphic++, x++, y--)
                    {
                        ApplyFoliageTransparency(graphic, x, y, z);
                    }

                    break;
                }
            }
        }

        private void ApplyFoliageTransparency(ushort graphic, int x, int y, int z)
        {
            GameObject tile = _world.Map.GetTile(x, y);

            if (tile != null)
            {
                for (GameObject obj = tile; obj != null; obj = obj.TNext)
                {
                    ushort testGraphic = obj.Graphic;

                    if (testGraphic == graphic && obj.Z == z)
                    {
                        obj.FoliageIndex = FoliageIndex;
                    }
                }
            }
        }

        private void UpdateObjectHandles(Entity obj, bool useObjectHandles)
        {
            if (useObjectHandles && _world.NameOverHeadManager.IsAllowed(obj))
            {
                if (obj.ObjectHandlesStatus != ObjectHandlesStatus.CLOSED)
                {
                    if (obj.ObjectHandlesStatus == ObjectHandlesStatus.NONE)
                    {
                        obj.ObjectHandlesStatus = ObjectHandlesStatus.OPEN;
                    }

                    obj.UpdateTextCoordsV();
                }
            }
            else if (obj.ObjectHandlesStatus != ObjectHandlesStatus.NONE)
            {
                obj.ObjectHandlesStatus = ObjectHandlesStatus.NONE;
                obj.UpdateTextCoordsV();
            }
        }

        private void CheckIfBehindATree(
            GameObject obj,
            ref StaticTiles itemData
        )
        {
            if (obj.Z < _maxZ && itemData.IsFoliage)
            {
                if (obj.FoliageIndex != FoliageIndex)
                {
                    sbyte index = 0;

                    bool check = _world.Player.X <= obj.X && _world.Player.Y <= obj.Y;

                    if (!check)
                    {
                        check = _world.Player.Y <= obj.Y && _world.Player.X <= obj.X + 1;

                        if (!check)
                        {
                            check = _world.Player.X <= obj.X && _world.Player.Y <= obj.Y + 1;
                        }
                    }

                    if (check)
                    {
                        var rect = Client.Game.UO.Arts.GetRealArtBounds(obj.Graphic);

                        rect.X = obj.RealScreenPosition.X - (rect.Width >> 1) + rect.X;
                        rect.Y = obj.RealScreenPosition.Y - rect.Height + rect.Y;

                        check = Exstentions.InRect(ref rect, ref _rectanglePlayer);

                        if (check)
                        {
                            index = FoliageIndex;
                            IsFoliageUnion(obj.Graphic, obj.X, obj.Y, obj.Z);
                        }
                    }

                    obj.FoliageIndex = index;
                }

                if (_foliageCount >= _foliages.Length)
                {
                    int newsize = _foliages.Length + 50;
                    Array.Resize(ref _foliages, newsize);
                }

                _foliages[_foliageCount++] = obj;
            }
        }

        private bool ProcessAlpha(
            GameObject obj,
            ref readonly StaticTiles itemData,
            out bool allowSelection
        )
        {
            allowSelection = true;

            if (obj.Z >= _maxZ)
            {
                bool changed;

                if (_alphaChanged)
                {
                    changed = CalculateAlpha(ref obj.AlphaHue, 0);
                }
                else
                {
                    changed = obj.AlphaHue != 0;
                }

                if (!changed)
                {
                    return false;
                }
            }
            else if (_noDrawRoofs && itemData.IsRoof)
            {
                if (_alphaChanged)
                {
                    if (!CalculateAlpha(ref obj.AlphaHue, 0))
                    {
                        return false;
                    }
                }

                return obj.AlphaHue != 0;
            }
            else if (itemData.IsTranslucent)
            {
                if (_alphaChanged)
                {
                    CalculateAlpha(ref obj.AlphaHue, 178);
                }
            }
            else if (_alphaChanged && obj.AlphaHue != 0xFF && !itemData.IsFoliage)
            {
                CalculateAlpha(ref obj.AlphaHue, 0xFF);
            }
            else if (obj.AlphaHue == 0 && !itemData.IsFoliage)
            {
                // v0.4.74: slow-path twin of the fresh-tile fix in the
                // mesh fast path. A just-loaded static below _maxZ that
                // isn't roof / translucent / foliage is normally opaque;
                // AlphaHue==0 here can only mean it was just added and
                // _alphaChanged has not fired yet to fade it in. Promote
                // so the caller (PushToRenderQueue / SetVisible) renders
                // it this frame instead of leaving a black square.
                // Foliage uses AlphaHue==0 intentionally for hidden-by-
                // canopy state, so it stays excluded.
                obj.AlphaHue = 0xFF;
            }

            return true;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private byte GetGradientCotAlpha(GameObject obj)
        {
            float dx = obj.RealScreenPosition.X - _cotPlayerScreenPos.X;
            float dy = (obj.RealScreenPosition.Y - 44) - _cotPlayerScreenPos.Y;
            float distSq = dx * dx + dy * dy;

            if (distSq >= _cotRadiusSq)
                return 0xFF;

            float ratio = (float)Math.Sqrt(distSq / _cotRadiusSq);
            return (byte)(ratio * ratio * ratio * 255f);
        }

        private static bool CalculateAlpha(ref byte alphaHue, int maxAlpha)
        {
            if (
                ProfileManager.CurrentProfile != null
                && !ProfileManager.CurrentProfile.UseObjectsFading
            )
            {
                alphaHue = (byte)maxAlpha;

                return maxAlpha != 0;
            }

            bool result = false;

            int alpha = alphaHue;

            if (alpha > maxAlpha)
            {
                alpha -= 25;

                if (alpha < maxAlpha)
                {
                    alpha = maxAlpha;
                }

                result = true;
            }
            else if (alpha < maxAlpha)
            {
                alpha += 25;

                if (alpha > maxAlpha)
                {
                    alpha = maxAlpha;
                }

                result = true;
            }

            alphaHue = (byte)alpha;

            return result;
        }

        private static byte CalculateObjectHeight(ref int maxObjectZ, ref StaticTiles itemData)
        {
            if (
                itemData.Height != 0xFF /*&& itemData.Flags != 0*/
            )
            {
                byte height = itemData.Height;

                if (itemData.Height == 0)
                {
                    if (!itemData.IsBackground && !itemData.IsSurface)
                    {
                        height = 10;
                    }
                }

                if ((itemData.Flags & TileFlag.Bridge) != 0)
                {
                    height /= 2;
                }

                maxObjectZ += height;

                return height;
            }

            return 0xFF;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static bool IsFoliageVisibleAtSeason(ref StaticTiles itemData, Season season)
        {
            return !(itemData.IsFoliage && !itemData.IsMultiMovable && season >= Season.Winter);
        }

        private bool HasSurfaceOverhead(Mobile mob)
        {
            if (
                mob.Serial == _world.Player.Serial /* || _maxZ == _maxGroundZ*/
            )
            {
                return false;
            }

            if (mob._surfaceOverheadCacheX == mob.X && mob._surfaceOverheadCacheY == mob.Y && mob._surfaceOverheadCacheMaxZ == _maxZ)
            {
                return mob._surfaceOverheadCache;
            }

            bool found = false;

            for (int y = -1; y <= 2; ++y)
            {
                for (int x = -1; x <= 2; ++x)
                {
                    GameObject tile = _world.Map.GetTile(mob.X + x, mob.Y + y);

                    found = false;

                    while (tile != null)
                    {
                        var next = tile.TNext;

                        if (tile.Z > mob.Z && (tile is Static || tile is Multi))
                        {
                            ref var itemData = ref Client.Game.UO.FileManager.TileData.StaticData[tile.Graphic];

                            if (itemData.IsNoShoot || itemData.IsWindow)
                            {
                                if (_maxZ - tile.Z + 5 >= tile.Z - mob.Z)
                                {
                                    found = true;

                                    break;
                                }
                            }
                        }

                        tile = next;
                    }

                    if (!found)
                    {
                        break;
                    }
                }

                if (!found)
                {
                    break;
                }
            }

            mob._surfaceOverheadCacheX = (ushort)mob.X;
            mob._surfaceOverheadCacheY = (ushort)mob.Y;
            mob._surfaceOverheadCacheMaxZ = _maxZ;
            mob._surfaceOverheadCache = found;

            return found;
        }

        // Returns: 0 = break (handled), 1 = continue (skip), 2 = return retValue from AddTileToRenderList
        private int ProcessStaticLikeTail(
            GameObject obj,
            ref StaticTiles itemData,
            bool allowSelection,
            int screenY,
            ref int maxObjectZ,
            int maxZ,
            out bool retValue,
            ChunkMesh mesh
        )
        {
            retValue = false;

            byte height = 0;

            if (obj.AllowedToDraw)
            {
                height = CalculateObjectHeight(ref maxObjectZ, ref itemData);
            }

            if (maxObjectZ > maxZ)
            {
                retValue = itemData.Height != 0 && maxObjectZ - maxZ < height;
                return 2;
            }

            if (screenY < _minPixel.Y || screenY > _maxPixel.Y)
            {
                return 1;
            }

            // If in chunk mesh, mark visible instead of adding to render list
            if (obj.InChunkMesh && obj.MeshSpriteIndex >= 0)
            {
                bool cot = ProfileManager.CurrentProfile.UseCircleOfTransparency
                    && obj.TransparentTest(_world.Player.Z + 5);

                // Objects above _maxZ (or hidden roofs) are fading out via ProcessAlpha:
                // gradient CoT must not overwrite that alpha or they never disappear.
                bool fadingOut = obj.Z >= _maxZ || (_noDrawRoofs && itemData.IsRoof);

                if (cot && _cotGradientMode && !fadingOut)
                {
                    obj.AlphaHue = GetGradientCotAlpha(obj);
                    if (obj.AlphaHue > 0)
                        PushToRenderQueue(obj, true, allowSelection);
                    return 0;
                }

                mesh.Statics.SetVisible(obj.MeshSpriteIndex, obj.AlphaHue, cot);
                ApplyMeshHue(obj, mesh.Statics);

                if (itemData.IsLight)
                {
                    AddLight(obj, obj, obj.RealScreenPosition.X + 22, obj.RealScreenPosition.Y + 22);
                }

                if (allowSelection && !(cot && IsMouseInsideCotCircle()) && obj.AllowedToDraw && obj.CheckMouseSelection())
                {
                    if (SelectedObject.Object is GameObject prev)
                    {
                        if (obj.CalculateDepthZ() >= prev.CalculateDepthZ())
                            SelectedObject.Object = obj;
                    }
                    else
                        SelectedObject.Object = obj;
                }
                return 0;
            }

            CheckIfBehindATree(obj, ref itemData);

            // Gradient CoT for non-mesh objects (trees, foliage, animated statics).
            // Skip objects fading out via ProcessAlpha (above _maxZ / hidden roofs),
            // otherwise the gradient alpha overwrites the fade and they never disappear.
            if (_cotGradientMode && ProfileManager.CurrentProfile.UseCircleOfTransparency
                && obj.Z < _maxZ && !(_noDrawRoofs && itemData.IsRoof)
                && obj.TransparentTest(_world.Player.Z + 5))
            {
                obj.AlphaHue = GetGradientCotAlpha(obj);
                if (obj.AlphaHue > 0)
                    PushToRenderQueue(obj, true, allowSelection);
                return 0;
            }

            // hacky way to render shadows without z-fight
            bool isShadow =
                ProfileManager.CurrentProfile.ShadowsEnabled
                && ProfileManager.CurrentProfile.ShadowsStatics
                && (
                    StaticFilters.IsTree(obj.Graphic, out _)
                    || itemData.IsFoliage
                    || StaticFilters.IsRock(obj.Graphic)
                );

            PushToRenderQueue(obj, isShadow, allowSelection);
            return 0;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private void ApplyMeshHue(GameObject obj, MeshLayer layer)
        {
            var profile = ProfileManager.CurrentProfile;
            int hue = obj.Hue;
            bool partial = false;

            // Bug O7: HighlightGameObjects was honoured for mobiles /
            // item gumps (MobileView / ItemView non-mesh paths) but
            // NOT here — statics / multis / land route through the
            // mesh builder on wasm so mouse-over never highlighted
            // them. Checking SelectedObject + the profile flag picks
            // up the same red tint desktop shows.
            if (profile.HighlightGameObjects && ReferenceEquals(SelectedObject.Object, obj))
            {
                hue = Constants.HIGHLIGHT_CURRENT_OBJECT_HUE;
            }
            else if (profile.NoColorObjectsOutOfRange && obj.Distance > _world.ClientViewRange)
            {
                hue = Constants.OUT_RANGE_COLOR;
            }
            else if (_world.Player.IsDead && profile.EnableBlackWhiteEffect)
            {
                hue = Constants.DEAD_RANGE_COLOR;
            }
            else if (obj is Static s)
            {
                partial = s.ItemData.IsPartialHue;
            }
            else if (obj is Multi m)
            {
                partial = m.ItemData.IsPartialHue;
            }

            float hueX, hueY;
            if (hue != 0)
            {
                hueX = hue - 1;
                if (obj is Land land && land.IsStretched)
                    hueY = ShaderHueTranslator.SHADER_LAND_HUED;
                else
                    hueY = partial ? ShaderHueTranslator.SHADER_PARTIAL_HUED : ShaderHueTranslator.SHADER_HUED;
            }
            else
            {
                hueX = 0;
                if (obj is Land land && land.IsStretched)
                    hueY = ShaderHueTranslator.SHADER_LAND;
                else
                    hueY = ShaderHueTranslator.SHADER_NONE;
            }

            layer.SetHue(obj.MeshSpriteIndex, hueX, hueY);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private bool IsMouseInsideCotCircle()
        {
            if (_cotRadiusSq <= 0)
                return false;
            float dx = SelectedObject.TranslatedMousePositionByViewport.X - _cotPlayerScreenPos.X;
            float dy = SelectedObject.TranslatedMousePositionByViewport.Y - _cotPlayerScreenPos.Y;
            return (dx * dx + dy * dy) < _cotRadiusSq;
        }

        // v0.4.49 broad-phase mouse-hit filter. The widest mouse-pickable
        // sprite in UO art (large trees, mountain peaks, columns, multi
        // tiles) is bounded by ~130 px horizontally × ~200 px above its
        // RealScreenPosition anchor and ~30 px below. Objects whose
        // anchor is further than that from the cursor can never produce
        // a pixel-mask hit, so the expensive `CheckMouseSelection ->
        // ArtFile.GetValidRefEntry -> Arts.PixelCheck` chain is pure
        // waste on them. Operator runmatch4.log: cache-MISS frames at
        // Z=100 cost 260-300 ms with stable=60 dirty=4 (chunk loop
        // iterates ~4000 objects × CheckMouseSelection). Adding the
        // broad-phase early-return filters ~95% of calls in dense scenes,
        // cutting the chunk-loop time without changing hover precision
        // (the filter is a strict superset of any pixel that could hit).
        private const int HIT_BBOX_HORIZONTAL = 130;
        private const int HIT_BBOX_ABOVE_ANCHOR = 200;
        private const int HIT_BBOX_BELOW_ANCHOR = 50;

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static bool IsWithinMouseHitBbox(GameObject obj)
        {
            int dx = obj.RealScreenPosition.X - SelectedObject.TranslatedMousePositionByViewport.X;
            if (dx < -HIT_BBOX_HORIZONTAL || dx > HIT_BBOX_HORIZONTAL)
                return false;
            int dy = obj.RealScreenPosition.Y - SelectedObject.TranslatedMousePositionByViewport.Y;
            // dy = anchor_y - mouse_y. anchor below mouse → dy > 0. UO
            // sprites extend UPWARD from anchor by up to ~200 px (tall
            // statics, multis). BELOW the anchor, ground-clutter statics
            // (snow piles, rocks, e.g. 0x17c3 / 0x17c5) sit in the tile's
            // bottom wedge: their opaque pixels reach ~44 px below the anchor
            // — the SAME 44 px the Land diamond does (drawn at +22, bottom
            // corner +22 more; see TrySelectObject). The old 30 px budget was
            // NOT a strict superset of those pixels, so the broad-phase
            // rejected the lower half of small statics BEFORE the pixel test
            // ran, and the land behind won the hover instead (a snow pile in
            // a tile corner was unselectable except on a thin band near its
            // anchor). 50 px covers the bottom wedge + a small overhang
            // margin. The pixel test (CheckMouseSelection) stays the
            // authority, so a wider window can only ADD correct candidates,
            // never produce a false hit.
            return dy >= -HIT_BBOX_BELOW_ANCHOR && dy <= HIT_BBOX_ABOVE_ANCHOR;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void TrySelectObject(GameObject obj, bool allowSelection)
        {
            if (!allowSelection || !obj.AllowedToDraw)
                return;
            // The broad-phase bbox filter exists ONLY to skip the expensive
            // pixel-mask chain (GetValidRefEntry -> PixelCheck) on statics
            // far from the cursor. Land has no pixel mask — its
            // CheckMouseSelection is an O(1) diamond / quad test — and a
            // land diamond extends a full 44 px BELOW its anchor (more for
            // stretched tiles in depressions), well past
            // HIT_BBOX_BELOW_ANCHOR (30). Applying the filter to Land
            // wrongly rejects the bottom wedge of every tile before the
            // hit-test runs, leaving a dead zone where the cursor picks no
            // ground. Skip the filter for Land and run its cheap test direct.
            if (obj is not Land && !IsWithinMouseHitBbox(obj))
                return;
            if (!obj.CheckMouseSelection())
                return;
            if (SelectedObject.Object is GameObject prev)
            {
                if (obj.CalculateDepthZ() >= prev.CalculateDepthZ())
                    SelectedObject.Object = obj;
            }
            else
                SelectedObject.Object = obj;
        }

        // v0.4.47: cache-HIT fast refresh. The previous v0.4.20.2 version
        // re-iterated all 5 _renderLists (Transparents, Animations,
        // Statics, StretchedTiles, Tiles) and called CheckMouseSelection
        // on every item — at runmatch Z=100 (operator log 2026-05-11)
        // this scan over 100s of items × pixel-mask reads ate
        // 130-168 ms / frame (5-7 FPS) while the chunk loop itself
        // reported `fillMs=0` in chunks-diff. Profile-grade waste:
        //
        //   Cache HIT preconditions = mouse + player + offset + tile
        //   bounds + zoom all UNCHANGED since last fill. Non-Mobile
        //   sprites are positioned by player/offset and tested against
        //   mouse, all stable → their CheckMouseSelection result is
        //   deterministically bit-identical to last frame's. Iterating
        //   Transparents / Statics / StretchedTiles / Tiles is pure
        //   repeated computation.
        //
        //   Only Mobiles can change between cache-hit frames: anim
        //   frame index advances on its own timer, shifting bbox /
        //   pixel mask without invalidating the cache key.
        //
        // New algorithm:
        //   1. Restore _cachedNonMobileSelection (set at end of last
        //      cache-MISS fill) as the baseline. Subsumes v0.4.44's
        //      meshed-Land/Static cache.
        //   2. Iterate _renderLists.Animations only. Mobiles that
        //      pixel-hit AND outrank current selection by depth-Z
        //      take it (same logic as the cache-miss path).
        //   3. Run TryRescueMobileSelectionViaBbox to recover alpha-
        //      jitter cases via rolling StableHitBox.
        //
        // Drops fill-sub from 130-168 ms (operator runmatch logs) to
        // <10 ms under the same conditions. Hover precision unchanged
        // (no behavioural regression — same final SelectedObject
        // produced as the old 5-list pass under the cache-key
        // invariants).
        private void RefreshSelectedObjectFromCachedRenderLists()
        {
            var animations = _renderLists.Animations;
            for (int i = 0; i < animations.Count; i++)
            {
                TrySelectObject(animations[i], true);
            }
            TryRescueMobileSelectionViaBbox();
        }

        // v0.4.20.3: second-pass mobile-bbox rescue. Runs after the regular
        // pixel-perfect pass. If no clickable object pixel-hit (SelectedObject
        // is null or only Land), check whether the cursor falls inside any
        // visible Mobile's rolling-union StableHitBox; if yes, that mobile
        // wins. This recovers the alpha-jitter case (cursor inside the mob
        // silhouette but the current anim frame's alpha is transparent at
        // the cursor pixel) without stealing clicks meant for pixel-perfect
        // hits behind the mob (door behind mounted player → door wins
        // because it pixel-hits in pass 1, so this pass is skipped).
        private void TryRescueMobileSelectionViaBbox()
        {
            // Pass 1 already produced a real-object hit (anything other
            // than null or Land). Don't override.
            if (SelectedObject.Object is GameObject prev && prev is not Land)
            {
                return;
            }
            var animations = _renderLists.Animations;
            for (int i = 0; i < animations.Count; i++)
            {
                if (animations[i] is Mobile mob && mob.AllowedToDraw && mob.CheckMouseSelectionStableBbox())
                {
                    if (SelectedObject.Object is GameObject prevSel)
                    {
                        if (mob.CalculateDepthZ() >= prevSel.CalculateDepthZ())
                        {
                            SelectedObject.Object = mob;
                        }
                    }
                    else
                    {
                        SelectedObject.Object = mob;
                    }
                }
            }
        }

        private void PushToRenderQueue(
            GameObject obj,
            bool isTransparent,
            bool allowSelection
        )
        {
            if (obj.AlphaHue == 0)
            {
                return;
            }

            // v0.4.49: broad-phase mouse-hit filter — same logic as
            // TrySelectObject. Skip the expensive CheckMouseSelection
            // chain (file-index lookup + pixel-mask sample) on objects
            // whose anchor is too far from the cursor to possibly hit.
            // `IsWithinMouseHitBbox` short-circuits before any of the
            // CoT / TransparentTest checks because those also cost more
            // than the bbox test.
            // `obj is Land || IsWithinMouseHitBbox` — see TrySelectObject:
            // the broad-phase filter must NOT clip Land. A land diamond
            // extends 44 px below its anchor, past HIT_BBOX_BELOW_ANCHOR
            // (30); filtering it leaves a dead wedge at the tile's bottom
            // where the cursor hit-tests no ground. Land's CheckMouseSelection
            // is O(1), so running it unconditionally costs nothing.
            if (
                allowSelection
                && obj.Z <= _maxGroundZ
                && obj.AllowedToDraw
                && (obj is Land || IsWithinMouseHitBbox(obj))
                && !(ProfileManager.CurrentProfile.UseCircleOfTransparency
                    && obj.TransparentTest(_world.Player.Z + 5)
                    && IsMouseInsideCotCircle())
                && obj.CheckMouseSelection()
            )
            {
                if (SelectedObject.Object is GameObject prev)
                {
                    if (obj.CalculateDepthZ() >= prev.CalculateDepthZ())
                    {
                        SelectedObject.Object = obj;
                    }
                }
                else
                {
                    SelectedObject.Object = obj;
                }
            }

            bool finalTransparent = isTransparent || obj.AlphaHue != byte.MaxValue;
            _renderLists.Add(obj, finalTransparent);

#if BROWSER_WASM
            // v0.4.51: record this slow-path contribution into the current
            // chunk's replay cache so stable+clean+no-alpha cache-MISS frames
            // can re-add without walking the chunk's tile linked lists.
            if (_currentChunkForRecord != null)
            {
                _currentChunkForRecord.CachedSlowPathContribs.Add(obj);
                _currentChunkForRecord.CachedSlowPathTransparent.Add(finalTransparent);
            }
#endif
        }

        private unsafe bool AddTileToRenderList(
            GameObject obj,
            bool useObjectHandles,
            int maxZ,
            Chunk chunk
        )
        {
            var profile = ProfileManager.CurrentProfile;
            var mesh = chunk.Mesh;
#if BROWSER_WASM
            // v0.4.51: every contribution (slow-path PushToRenderQueue +
            // mesh fast-path) records into this chunk's replay cache.
            _currentChunkForRecord = chunk;
            // Positions can be stale behind UpdateDrawPosition's back (see Chunk.RspOffX).
            bool refreshDrawPosition = UpdateDrawPosition || chunk.RspOffX != _offset.X || chunk.RspOffY != _offset.Y;
#else
            bool refreshDrawPosition = UpdateDrawPosition;
#endif
            // THE WHOLE CHAIN, BEFORE THE LOOP: the loop below leaves at the first object outside the clip and
            // returns early in several places, so refreshing object by object left the rest of the cell at the
            // old offset, and nothing refreshed it later.
            if (refreshDrawPosition)
            {
                for (GameObject r = obj; r != null; r = r.TNext)
                {
                    r.UpdateRealScreenPosition(_offset.X, _offset.Y);
                }
            }

            for (; obj != null; obj = obj.TNext)
            {
                if (obj.IsPositionChanged)
                {
                    obj.UpdateRealScreenPosition(_offset.X, _offset.Y);
                }

                int screenX = obj.RealScreenPosition.X;

                if (screenX < _minPixel.X || screenX > _maxPixel.X)
                {
                    break;
                }

                int screenY = obj.RealScreenPosition.Y;
                int maxObjectZ = obj.PriorityZ;

                // Fast path: meshed objects (statics, multis, land) skip type-switch entirely
                if (obj.InChunkMesh)
                {
                    if (obj is Land meshLand)
                    {
#if BROWSER_WASM
                        if (_teleDiagDumpChunks) _diagLandIter++;
#endif
                        // For stretched tiles, the visible area extends below screenY
                        // based on MinZ, so use adjustedY for the top-of-screen cull.
                        if (meshLand.IsStretched)
                        {
                            int adjustedY = screenY + (meshLand.Z << 2) - (meshLand.MinZ << 2);
                            if (adjustedY < _minPixel.Y || screenY > _maxPixel.Y)
                            {
#if BROWSER_WASM
                                if (_teleDiagDumpChunks) _diagLandClipY++;
#endif
                                continue;
                            }
                        }
                        else if (screenY < _minPixel.Y || screenY > _maxPixel.Y)
                        {
#if BROWSER_WASM
                            if (_teleDiagDumpChunks) _diagLandClipY++;
#endif
                            continue;
                        }

                        if (maxObjectZ > maxZ)
                        {
#if BROWSER_WASM
                            if (_teleDiagDumpChunks) _diagLandMaxZ++;
#endif
                            return false;
                        }

                        // Simplified alpha for land (no itemData needed)
                        if (obj.Z > _maxGroundZ)
                        {
                            bool changed = _alphaChanged
                                ? CalculateAlpha(ref obj.AlphaHue, 0)
                                : obj.AlphaHue != 0;

                            if (!changed)
                                break;
                        }
                        else if (_alphaChanged && obj.AlphaHue != 0xFF)
                        {
                            CalculateAlpha(ref obj.AlphaHue, 0xFF);
                        }
                        else if (obj.AlphaHue == 0)
                        {
                            // v0.4.74: fresh tile (just-built mesh, never
                            // processed by _alphaChanged). Promote to opaque
                            // so SetVisible below fires this frame. Without
                            // this, the tile sprite's Visible[idx] stays
                            // false until the next _alphaChanged tick
                            // (~150-300ms later) — visible as post-teleport
                            // BLACK squares that disappear when the player
                            // walks one tile (UpdateDrawPosition retriggers
                            // a fresh fill with alphaChanged eventually).
                            // Below _maxGroundZ Land is normally opaque, so
                            // AlphaHue==0 here can only mean "just built".
                            obj.AlphaHue = 0xFF;
#if BROWSER_WASM
                            if (_teleDiagDumpChunks) _diagLandAlphaPromoted++;
#endif
                        }

                        if (obj.AlphaHue != 0)
                        {
#if BROWSER_WASM
                            if (_teleDiagDumpChunks)
                            {
                                if (obj.MeshSpriteIndex < 0) _diagLandSpriteMissing++;
                                else _diagLandSetVis++;
                            }
#endif
                            mesh.Land.SetVisible(obj.MeshSpriteIndex, obj.AlphaHue);
                            ApplyMeshHue(obj, mesh.Land);
                            TrySelectObject(obj, true);
#if BROWSER_WASM
                            // v0.4.51: record mesh fast-path contribution
                            // for chunk-replay on stable+clean cache-MISS.
                            chunk.CachedMeshContribs.Add(obj);
#endif
                        }
                        continue;
                    }

                    if (screenY < _minPixel.Y || screenY > _maxPixel.Y)
                        continue;

                    // Static or Multi — meshed objects are never foliage/trees/internal/animated
                    ref StaticTiles meshItemData = ref (obj is Static meshStatic
                        ? ref meshStatic.ItemData
                        : ref Unsafe.As<Multi>(obj).ItemData);

                    // Simplified ProcessAlpha for meshed statics: skip IsFoliage branch (never true)
                    bool meshAllowSelection = true;
                    bool meshFadingOut = false;
                    if (obj.Z >= _maxZ)
                    {
                        bool changed = _alphaChanged
                            ? CalculateAlpha(ref obj.AlphaHue, 0)
                            : obj.AlphaHue != 0;

                        if (!changed)
                            continue;

                        meshFadingOut = true;
                        meshAllowSelection = false;
                    }
                    else if (_noDrawRoofs && meshItemData.IsRoof)
                    {
                        if (_alphaChanged && !CalculateAlpha(ref obj.AlphaHue, 0))
                            continue;
                        if (obj.AlphaHue == 0)
                            continue;

                        meshFadingOut = true;
                        meshAllowSelection = false;
                    }
                    else if (meshItemData.IsTranslucent)
                    {
                        if (_alphaChanged)
                            CalculateAlpha(ref obj.AlphaHue, 178);
                    }
                    else if (_alphaChanged && obj.AlphaHue != 0xFF)
                    {
                        CalculateAlpha(ref obj.AlphaHue, 0xFF);
                    }
                    else if (obj.AlphaHue == 0)
                    {
                        // v0.4.74: same fresh-tile fix as Land above.
                        // Mesh-fast-path Statics below _maxZ that are NOT
                        // roof / translucent / fading-out are normally
                        // opaque. AlphaHue==0 here can only mean the
                        // static was just freshly built into the chunk
                        // mesh and never processed by _alphaChanged.
                        // Without promotion, the static sprite stays
                        // invisible until the next alpha tick — visible
                        // as post-teleport black squares wherever a
                        // chunk was just built mid-burst.
                        obj.AlphaHue = 0xFF;
                    }

                    if (obj.AlphaHue == 0)
                        continue;

                    // Z-height culling
                    if (obj.AllowedToDraw)
                        CalculateObjectHeight(ref maxObjectZ, ref meshItemData);

                    if (maxObjectZ > maxZ)
                        continue;

                    // Fading statics must not be drawn from the mesh GPU buffer because
                    // they write to the depth buffer and block objects underneath (mobiles, items).
                    // Instead, draw them via the CPU transparent list (rendered after mobiles).
                    if (meshFadingOut)
                    {
                        PushToRenderQueue(obj, true, false);
                        continue;
                    }

                    bool meshCot = ProfileManager.CurrentProfile.UseCircleOfTransparency
                        && obj.TransparentTest(_world.Player.Z + 5);

                    // Gradient CoT: set alpha on CPU and route to transparent list
                    // so depth buffer doesn't block mobiles underneath.
                    if (meshCot && _cotGradientMode)
                    {
                        obj.AlphaHue = GetGradientCotAlpha(obj);
                        if (obj.AlphaHue > 0)
                            PushToRenderQueue(obj, true, meshAllowSelection);
                        continue;
                    }

                    mesh.Statics.SetVisible(obj.MeshSpriteIndex, obj.AlphaHue, meshCot);
                    ApplyMeshHue(obj, mesh.Statics);

                    if (meshItemData.IsLight)
                    {
                        AddLight(obj, obj, obj.RealScreenPosition.X + 22, obj.RealScreenPosition.Y + 22);
                    }

                    TrySelectObject(obj, meshAllowSelection && !(meshCot && IsMouseInsideCotCircle()));
#if BROWSER_WASM
                    // v0.4.51: record mesh fast-path contribution for
                    // chunk-replay on stable+clean cache-MISS frames.
                    chunk.CachedMeshContribs.Add(obj);
#endif
                    continue;
                }

                switch (obj)
                {
                    case Land land:
                        if (maxObjectZ > maxZ)
                        {
                            return false;
                        }

                        if (screenY > _maxPixel.Y)
                        {
                            continue;
                        }

                        if (land.IsStretched)
                        {
                            screenY += (land.Z << 2);
                            screenY -= (land.MinZ << 2);
                        }

                        if (screenY < _minPixel.Y)
                        {
                            continue;
                        }

                        PushToRenderQueue(
                            obj,
                            false,
                            true
                        );
                        break;
                    case Static staticc:
                        {
                            ref var itemData = ref staticc.ItemData;

                            if (itemData.IsInternal)
                            {
                                continue;
                            }

                            if (!IsFoliageVisibleAtSeason(ref itemData, _world.Season))
                            {
                                continue;
                            }

                            if (
                                !ProcessAlpha(
                                    obj,
                                    ref itemData,
                                    out bool allowSelection
                                )
                            )
                            {
                                continue;
                            }

                            if (itemData.IsFoliage && profile.TreeToStumps)
                            {
                                continue;
                            }

                            if (
                                !itemData.IsMultiMovable
                                && staticc.IsVegetation
                                && profile.HideVegetation
                            )
                            {
                                continue;
                            }

                            int cf = ProcessStaticLikeTail(obj, ref itemData, allowSelection, screenY, ref maxObjectZ, maxZ, out bool retVal, mesh);
                            if (cf == 1) continue;
                            if (cf == 2) return retVal;
                            break;
                        }

                    case Multi multi:
                        {
                            ref StaticTiles itemData = ref multi.ItemData;

                            if (itemData.IsInternal)
                            {
                                continue;
                            }

                            if (
                                !ProcessAlpha(
                                    obj,
                                    ref itemData,
                                    out bool allowSelection
                                )
                            )
                            {
                                continue;
                            }

                            if (!itemData.IsMultiMovable)
                            {
                                if (itemData.IsFoliage && profile.TreeToStumps)
                                {
                                    continue;
                                }

                                if (multi.IsVegetation && profile.HideVegetation)
                                {
                                    continue;
                                }
                            }

                            int cf = ProcessStaticLikeTail(obj, ref itemData, allowSelection, screenY, ref maxObjectZ, maxZ, out bool retVal, mesh);
                            if (cf == 1) continue;
                            if (cf == 2) return retVal;
                            break;
                        }

                    case Mobile mobile:
                        {
#if BROWSER_WASM
                            // v0.4.50: defer Mobile slow-path processing for
                            // dirty chunks during teleport-burst. The mesh
                            // renders normally; only the non-meshed mobile
                            // sprite waits one frame for the chunk to settle.
                            // Saves the per-mobile UpdateObjectHandles +
                            // ProcessAlpha + PushToRenderQueue chain during
                            // the 4-fill burst where mesh.Build is still
                            // catching up to the server's entity push.
                            if (_fillTeleportRemainingFills > 0 && chunk.Mesh.IsDirty)
                            {
                                continue;
                            }
#endif
                            UpdateObjectHandles(mobile, useObjectHandles);

                            maxObjectZ += Constants.DEFAULT_CHARACTER_HEIGHT;

                            if (maxObjectZ > maxZ)
                            {
                                return false;
                            }

                            StaticTiles empty = default;

                            if (
                                !ProcessAlpha(
                                    obj,
                                    ref empty,
                                    out bool allowSelection
                                )
                            )
                            {
                                continue;
                            }

                            if (screenY < _minPixel.Y || screenY > _maxPixel.Y)
                            {
                                continue;
                            }

                            obj.AllowedToDraw = !HasSurfaceOverhead(mobile);

                            PushToRenderQueue(
                                obj,
                                false,
                                allowSelection
                            );
                            break;
                        }

                    case Item item:
                        {
#if BROWSER_WASM
                            // v0.4.50: defer Item slow-path processing for
                            // dirty chunks during teleport-burst. Operator
                            // runmatch5.log frame n=11-14 showed ~490 arena
                            // items pushed by the server over 4 fills,
                            // 800ms per fill. With this defer, item slow-
                            // path (ItemData lookup + ProcessAlpha + bbox-
                            // test + PushToRenderQueue) is skipped while
                            // the chunk's mesh is still being built; items
                            // pop in over the next 4 frames at 60 FPS
                            // instead of locking the page for ~3 seconds.
                            if (_fillTeleportRemainingFills > 0 && chunk.Mesh.IsDirty)
                            {
                                continue;
                            }
#endif
                            ref StaticTiles itemData = ref (
                                item.IsMulti
                                    ? ref Client.Game.UO.FileManager.TileData.StaticData[item.MultiGraphic]
                                    : ref item.ItemData
                            );

                            if (!item.IsCorpse && itemData.IsInternal)
                            {
                                continue;
                            }

                            if (
                                item.IsCorpse
                                || (
                                    !item.IsMulti
                                    && (!item.IsLocked || item.IsLocked && itemData.IsContainer)
                                )
                            )
                            {
                                UpdateObjectHandles(item, useObjectHandles);
                            }

                            if (!item.IsMulti && !IsFoliageVisibleAtSeason(ref itemData, _world.Season))
                            {
                                continue;
                            }

                            if (
                                !ProcessAlpha(
                                    obj,
                                    ref itemData,
                                    out bool allowSelection
                                )
                            )
                            {
                                continue;
                            }

                            if (
                                !itemData.IsMultiMovable
                                && itemData.IsFoliage
                                && profile.TreeToStumps
                            )
                            {
                                continue;
                            }

                            byte height = 0;

                            if (obj.AllowedToDraw)
                            {
                                height = CalculateObjectHeight(ref maxObjectZ, ref itemData);
                            }

                            if (maxObjectZ > maxZ)
                            {
                                return itemData.Height != 0 && maxObjectZ - maxZ < height;
                            }

                            if (screenY < _minPixel.Y || screenY > _maxPixel.Y)
                            {
                                continue;
                            }

                            if (!item.IsCorpse)
                            {
                                CheckIfBehindATree(obj, ref itemData);
                            }

                            if (item.IsCorpse)
                            {
                                PushToRenderQueue(
                                    obj,
                                    false,
                                    allowSelection
                                );
                            }
                            else
                            {
                                PushToRenderQueue(
                                    obj,
                                    false,
                                    true
                                );
                            }

                            break;
                        }

                    case GameEffect effect:
                        if (effect is not LightningEffect &&
                            !ProcessAlpha(
                                obj,
                                ref Client.Game.UO.FileManager.TileData.StaticData[effect.Graphic],
                                out _
                            ))
                        {
                            continue;
                        }

                        if (screenY < _minPixel.Y || screenY > _maxPixel.Y)
                        {
                            continue;
                        }

                        if (effect.IsMoving) // TODO: check for typeof(MovingEffect) ?
                        { }

                        //PushToRenderList(obj, ref _renderList, ref _renderListStaticsHead, ref _renderListStaticsCount, false);

                        PushToRenderQueue(
                            obj,
                            false,
                            false
                        );
                        break;
                }
            }

            return false;
        }

        private void GetViewPort()
        {
            int oldDrawOffsetX = _offset.X;
            int oldDrawOffsetY = _offset.Y;
            Point old_scaled_offset = _last_scaled_offset;

            float zoom = Camera.Zoom;

            int winGamePosX = 0;
            int winGamePosY = 0;
            int winGameWidth = Camera.Bounds.Width;
            int winGameHeight = Camera.Bounds.Height;
            int winGameCenterX = winGamePosX + (winGameWidth >> 1);
            int winGameCenterY = winGamePosY + (winGameHeight >> 1) + (_world.Player.Z << 2);
            winGameCenterX -= (int)_world.Player.Offset.X;
            winGameCenterY -= (int)(_world.Player.Offset.Y - _world.Player.Offset.Z);

            int tileOffX = _world.Player.X;
            int tileOffY = _world.Player.Y;

            int winDrawOffsetX = (tileOffX - tileOffY) * 22 - winGameCenterX;
            int winDrawOffsetY = (tileOffX + tileOffY) * 22 - winGameCenterY;

            int winGameScaledOffsetX;
            int winGameScaledOffsetY;
            int winGameScaledWidth;
            int winGameScaledHeight;

            if (zoom != 1f)
            {
                float left = winGamePosX;
                float right = winGameWidth + left;
                float top = winGamePosY;
                float bottom = winGameHeight + top;
                float newRight = right * zoom;
                float newBottom = bottom * zoom;

                winGameScaledOffsetX = (int)(left * zoom - (newRight - right));
                winGameScaledOffsetY = (int)(top * zoom - (newBottom - bottom));
                winGameScaledWidth = (int)(newRight - winGameScaledOffsetX);
                winGameScaledHeight = (int)(newBottom - winGameScaledOffsetY);
            }
            else
            {
                winGameScaledOffsetX = 0;
                winGameScaledOffsetY = 0;
                winGameScaledWidth = 0;
                winGameScaledHeight = 0;
            }

            int size = (int)(Math.Max(winGameWidth / 44f + 1, winGameHeight / 44f + 1) * zoom);

            // v0.4.77: pad `size` by +1 to cover Player.Offset sub-tile
            // walk-step drift. Without this, the visible iso shifts up to
            // ±22 px (1 tile) per axis during a walk step (winGameCenter
            // -= Player.Offset above), but the integer-tile iteration
            // range stays centered on Player.X/Y. Result: edge tiles on
            // the lead-side of motion render off-canvas (clipped) while
            // tiles entering from the trail-side aren't iterated at all,
            // leaving the missing-tile "sawtooth wedge" operator reported
            // 2026-05-13. Symptom appears in EVERY frame where
            // Player.Offset != 0: normal walking (Walker animates Offset
            // each step), short `[tele 1-2 tiles` (below the burst
            // threshold of 5, so the client treats it as a walk-step
            // animation rather than a teleport), and the manual
            // target-cursor `[tele <spot>` flow (mouse motion frames
            // during target-pick). [teleburst custom command does NOT
            // reproduce because its server-side MoveToWorld emits
            // 0x20 UpdatePlayer which calls ClearSteps() → Offset=0,
            // no drift to compensate for.
            size += 1;

            if (Camera.Offset.X != 0 || Camera.Offset.Y != 0)
            {
                tileOffX += (int)(zoom * (Camera.Offset.X + Camera.Offset.Y) / 44);
                tileOffY += (int)(zoom * (Camera.Offset.Y - Camera.Offset.X) / 44);
            }
            // v0.4.77: same shift for Player.Offset (walk-step interp)
            // so the iteration range follows the rendering shift. Math
            // matches Camera.Offset path: iso transform world (X,Y) →
            // screen (X-Y, X+Y), inverse for screen (sx, sy) → world
            // (sx+sy, sy-sx) all scaled by /44.
            if (_world.Player.Offset.X != 0 || _world.Player.Offset.Y != 0)
            {
                float pOffX = _world.Player.Offset.X;
                float pOffY = _world.Player.Offset.Y - _world.Player.Offset.Z;
                tileOffX -= (int)(zoom * (pOffX + pOffY) / 44);
                tileOffY -= (int)(zoom * (pOffY - pOffX) / 44);
            }
            ;

            // Player.Z shifts winGameCenterY by (Z<<2) pixels but `size` (axis-aligned
            // X/Y half-extent) is computed only from window dims/zoom and never sees Z.
            // At high |Z|, the iteration box no longer covers the diagonal band that
            // remains visible after the screen shift — visible tiles on the "lifted" side
            // (north for Z>0, south for Z<0) fall outside the box and the chunk loop
            // never visits them, leaving a black strip at the screen edge.
            // Compensate asymmetrically so normal-Z play (the 99% case) pays no extra cost.
            int playerZ = _world.Player.Z;
            int zExtraNorth = playerZ > 0 ? (playerZ * 4 + 43) / 44 : 0;
            int zExtraSouth = playerZ < 0 ? (-playerZ * 4 + 43) / 44 : 0;
            int zNorthPerAxis = (zExtraNorth + 1) / 2;
            int zSouthPerAxis = (zExtraSouth + 1) / 2;

            int realMinRangeX = Math.Max(0, tileOffX - size - zNorthPerAxis);
            int realMaxRangeX = tileOffX + size + zSouthPerAxis;
            int realMinRangeY = Math.Max(0, tileOffY - size - zNorthPerAxis);
            int realMaxRangeY = tileOffY + size + zSouthPerAxis;

            int drawOffset = (int)(44 / zoom);

            Point p = Point.Zero;
            p.X -= drawOffset;
            p.Y -= drawOffset;
            p = Camera.ScreenToWorld(p);
            int minPixelsX = p.X;
            int minPixelsY = p.Y;

            p.X = Camera.Bounds.Width + drawOffset;
            p.Y = Camera.Bounds.Height + drawOffset;
            p = Camera.ScreenToWorld(p);
            int maxPixelsX = p.X;
            int maxPixelsY = p.Y;

            if (
                UpdateDrawPosition
                || oldDrawOffsetX != winDrawOffsetX
                || oldDrawOffsetY != winDrawOffsetY
                || old_scaled_offset.X != winGameScaledOffsetX
                || old_scaled_offset.Y != winGameScaledOffsetY
                || _lastCamOffset != Camera.Offset
            )
            {
                UpdateDrawPosition = true;
                _lastCamOffset = Camera.Offset;
            }

            _minTile.X = realMinRangeX;
            _minTile.Y = realMinRangeY;
            _maxTile.X = realMaxRangeX;
            _maxTile.Y = realMaxRangeY;

            _minPixel.X = minPixelsX;
            _minPixel.Y = minPixelsY;
            _maxPixel.X = maxPixelsX;
            _maxPixel.Y = maxPixelsY;

            _offset.X = winDrawOffsetX;
            _offset.Y = winDrawOffsetY;

            _last_scaled_offset.X = winGameScaledOffsetX;
            _last_scaled_offset.Y = winGameScaledOffsetY;

            UpdateMaxDrawZ();
        }

        private struct TreeUnion
        {
            public TreeUnion(ushort start, ushort end)
            {
                Start = start;
                End = end;
            }

            public readonly ushort Start;
            public readonly ushort End;
        }
    }
}
