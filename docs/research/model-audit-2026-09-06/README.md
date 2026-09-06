# Independent visual audit of build 31 models

Reviewed 2026-09-06 after renewed user feedback. This is a defect list, not a
visual acceptance report. The initial Blender evidence is the committed
`17783ab` preview set; relative `model-previews` links now show the latest
regeneration, so use that revision for the original coordinates. Retained
native build31 screenshots remain unchanged. All seven six-view Blender sheets, four full-size
cab details, and retained build31 native iPhone cab views were actually opened.
Primary DPP photos were opened separately. Passing the previous GLB validator
or XCTest control flow did not establish faithful geometry.

Coordinates below are fractions of the **whole original image**, measured from
the top-left; `(0.5, 0.5)` means its center. These locate a region for inspection,
not a calibrated physical measurement. Source URLs and credits are retained in
`../../model-references/sources.json`. The existing references are evidence;
no generated photograph or synthetic reference is used.

## Fix order

1. **Visible chassis escapes the nose silhouette.** In native
   [14T front](../../testing/results/iphone-2026-09-06/14t-front-build31.png),
   black triangles project beyond both lower rounded corners at approximately
   `(0.20,0.49)` and `(0.79,0.49)`. The same defect appears in
   [52T front](../../testing/results/iphone-2026-09-06/52t-front-build31.png)
   around `(0.19,0.49)` and `(0.80,0.49)`, and its rear. This is separate from
   the removed white ground effect. The chassis/underframe must follow or sit
   inside the tapered body envelope. Rounded visible bodywork cannot finish
   over a rectangular black board that sticks out behind it. Root confirmed
   this finding and owns the mesh correction.

2. **T3, T3R.P and T3R.PLF are missing the depth of the lower body apron.**
   [T3 detail](../../model-previews/t3-detail.png), region `(0.40–0.71,0.73–0.84)`,
   has a narrow cream strip and an almost toy-like exposed running frame.
   [DPP 6102](../../model-references/t3-01.jpg), lower front and left-side
   body, shows a deep rounded cream apron with localized wheel openings,
   substantial front coupler recess and a prominent metal belt above it.
   [DPP 8284](../../model-references/t3rplf-01.jpg) confirms the apron on PLF.
   This changes the whole height distribution and silhouette, not just paint.
   Fix the body section and cutouts before adding small labels.

3. **Faceted surface patches remain visible after the depth-buffer fix.**
   Native [52T front](../../testing/results/iphone-2026-09-06/52t-front-build31.png)
   shows a large angular tonal polygon across the lower black mask near
   `(0.32–0.56,0.37–0.43)`; the colored number patch has a rectangular tonal
   step at `(0.58–0.72,0.42–0.46)`. Several Blender cab details also have
   boundaries that read as separate stuck-on sheets, especially the door/cab
   junction of [52T](../../model-previews/52t-detail.png) around `(0.31–0.40,0.53–0.79)`.
   Distinguish a legitimate body crease from a polygon edge that follows a
   decal boundary. Root traced patch normals differing from the hull normals;
   this audit only establishes the visible discontinuity, not that diagnosis.

4. **Articulations look like solid black spacer boxes.** The four articulated
   [sheets](../../model-previews/README.md) show smooth, nearly featureless
   black blocks at every gap; raised roof corners make the assembly look like
   independent rectangular cars joined by filler. Compare
   [KT8 DPP side](../../model-references/kt8d5-01.jpg), where the bellows have
   unmistakable repeated vertical pleats, rounded transitions at the roof,
   and a defined lower edge. The same language is visible in
   [52T DPP side](../../model-references/52t-03.jpg). For KT8 use the two joint
   regions in the top-center panel of `kt8d5.png`, approximately x=0.46/0.54,
   y=0.25–0.28. Preserve measured gap lengths; improve cross-section and folds.

5. **Cab recognition still relies on paint over a generic rounded box.**
   Most obvious in 15T: [model detail](../../model-previews/15t-detail.png)
   has a modestly curved rectangular screen and three round lamps on a thick
   black brick `(0.43–0.53,0.71–0.76)`. [DPP front pair](../../model-references/15t-01.jpg)
   shows a larger curved glass/mask assembly, a broad sculpted light surround
   integrated into the pale band and a substantial lower valance; the glass,
   belt, lamp pocket and nose are one designed form. Simply adding three bulbs
   and a route number does not recreate it. Use the DPP original red-roof car
   on the right for the current variant, not the yellow-roof car on the left.

## Family-specific remaining findings

| Family | Observable issue and location | Reference / required comparison |
| --- | --- | --- |
| T3 | Deep apron/recess absent; thin cream side strips break around doors; door glass is drawn as four uninterrupted tall slots. In `t3-detail.png`, door region x=0.30–0.40, y=0.40–0.74. | `t3-01.jpg` for body volume; `t3rp-02.jpg` for the clearly separated upper/lower door windows. Do not use the classic windscreen divider as a claim without checking the exact car variant. |
| T3R.P | Same lower-body and door-window issues; the mechanical distinction from classic T3 is largely reduced to roof blocks and text. | DPP `t3rp-01.jpg` and `t3rp-02.jpg`: actual skirt, vent grille, bumpers, door mullions and equipment proportions. |
| T3R.PLF | Low center window ends are sharp rectangles; in the non-door-side top-right panel of `t3rplf.png`, x=0.78–0.84, y=0.24–0.30. The central cream nose chevron is a sharp triangular wedge. | `t3rplf-03.jpg` shows visibly rounded U-like lower center glazing; `technical/t3plf-front-assembly-dpp.png` shows the curved nose transition and deep cream apron. Preserve the measured drop locations, reshape their boundary. |
| KT8D5.RN2P | Solid-looking bellows; cab lower front lacks the large projecting central coupler/guard assembly and reads as a flat grey box. In `kt8d5.png` front detail/head-on, nose center below the number. | `kt8d5-03.jpg` clearly exposes central coupling gear below the red front band; `kt8d5-01.jpg` resolves pleats and lower white body. Bidirectional cab symmetry itself is legitimate. |
| 14T | Chassis corners above; left mirror support has a visible gap to the mirror in native front: x≈0.095, y≈0.18. Cab-side glazing becomes narrow vertical strips rather than the larger tapered wrap visible in three-quarter photos. | `14t-01.jpg`, `14t-04.jpg`, and PID four views. Asymmetric mirror mounting is legitimate; the discontinuous physical connection is the issue. |
| 15T | Thick raised lamp bricks, insufficiently sculpted front belt/valance; harsh door-header gaps and rectangular equipment blocks dominate the otherwise smooth shell. | DPP `15t-01.jpg`/`15t-02.jpg`. Secondary `technical/15t-rear-photographer.jpg` is useful only as a supplementary close rear detail; it is not an operator source. |
| 52T | Chassis corners and mask/paint patch discontinuities above; all side glazing/door panels appear thickly stacked over the shell in detail. Roof air-conditioning is simplified to generic thick rectangular boxes. | `52t-03.jpg` for coherent side glazing/door fit, `52t-06.jpg` for frontal body shape and flush lights, factory rear in `technical/52t-rear-dpp.png`. |

## Corrected inference and limits

An initial suggestion that 52T's red nose stripe should be centered was wrong.
The more frontal [DPP 52t-06](../../model-references/52t-06.jpg) and factory rear
show its intentional asymmetry. `52t-05.jpg` alone was misleading because of
perspective. **Do not center the stripe.**

The repeated surface/underframe issues are visible without knowledge of a tram
prototype. Lamp shapes, glass boundaries, aprons and door mullions require the
variant-specific references above. No dimension error is inferred merely from
a perspective photo. These retained build31 images cannot accept later mesh
changes; rerender the affected close-up views and obtain fresh native evidence.

## Physical-device read-only recheck

### Subsequent implementation and native32 inspection

The later seven-model regeneration closes the visible underframe protrusions,
deepens the Tatra aprons, separates upper/lower door glass, fills door headers,
adds pleated articulation cross-sections and shares clipped-patch normals with
the parent hull. Variant-specific follow-up work reshapes PLF's curved chevron,
closed apron/narrow coupler slot and rounded low glazing; gives RP/PLF flat LED
enclosures; enlarges 14T wrap glazing and connects its mirror support; and
reworks 15T's screen, lamp pockets, lower light strip, valance and linked wiper
against the additional high-resolution DPP front photograph. KT8 coupling
projection/height follows the original type drawing. The final exported53GLBs
pass their structural and budget gates, separately from visual review.

Native32 front/rear screenshots of all seven models were opened. They exposed
another shared defect: the ready-state card shrinks the GLView, while Expo57's
JavaScript drawing-buffer dimensions stay at their initial values. The roof and
sign disappear above the viewport, especially on the Škodas. Retained
[15T evidence](../../testing/results/iphone-2026-09-06/15t-front-build32-cropped.png)
shows why successful control assertions did not establish correct framing.
The viewer now uses measured layout pixels to resize its renderer, render target
and projection together. Acceptance requires the subsequent native build's
front/rear and iPad rotation images; the old native32 screenshot cannot accept
that correction.

At **2026-09-06 09:43:55 UTC (11:43:55 CEST)**, `devicectl list devices`
remembered `pipka` iPhone17Pro as **unavailable**. A bounded bundle-filtered
`device info apps` request failed immediately with CoreDevice error1011
(device not located). No installation, app launch, simulator, or security
change was attempted. Therefore this recheck cannot independently confirm the
currently installed version or the phone-to-private-backend network path.
Earlier installation evidence remains historical; Mac-to-server reachability
would not prove the phone's private connectivity.


## Follow-up review, 12:25–12:35 CEST

Reopened fresh head-on/tail-on images for all seven families and three-quarter
views for14T,15T,52T,KT8 and PLF. Compared primary DPP52t-06,15t-06-dpp-front,
14t-01,kt8d5-03,t3-01,t3rp-02,t3rplf-01 and the52T factory rear; the9389 rear
photo is supplementary and represents a later15T variant.

- The previously protruding14T/52T chassis corners and disconnected14T mirror
  arm are no longer apparent in these new frontal renders. This is Blender
  evidence; fresh native acceptance is still required.
-15T: the lower red valance is too shallow relative to its white middle belt
  in the12:07 head-on render (roughly0.85 red:white height, versus about1.45
  in DPP9229). The lower black lamp strip is continuous across the real nose;
  the earlier model has two isolated corner pods. Root is adjusting these
  forms using that photo, preserving the9286 livery. These are local ratios
  for comparison, not calibrated vehicle dimensions from a perspective image.
- PLF: the broad rectangular route-display case in DPP8284 is materially wider
  than the classic pill-shaped display retained in the12:24 model. Approximate
  display:front widths are0.73 in the photograph versus0.53 in the preview.
  Root received the source and concrete difference. The lower U-shaped center
  windows and deeper apron now read closer to the reference.
- Apparent mirrors beside modern rear ends in the orthographic tail-on renders
  are the far-away **front** mirrors visible beyond the body silhouette.
  Generator inspection confirms mirrors are front-only except bidirectional
  KT8. Do not add/remove rear mirror geometry based on that projection artifact.
- Classic6102's linked Y-shaped central wiper assembly was independently
  reconfirmed in DPPt3-01; it is not an accidental three-spoke mesh.
