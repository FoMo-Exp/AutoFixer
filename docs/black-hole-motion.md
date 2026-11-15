# Startup black-hole motion: physical references and visual model

## Observational basis

- Accretion is orbiting gas migrating inward through a disk. The displayed upper/lower arcs are gravitationally lensed images of the disk's far side, not matter physically climbing over the black hole. [NASA anatomy](https://science.nasa.gov/universe/black-holes/anatomy/)
- Inner disk material orbits faster than outer material. Differential rotation produces stretched, sheared bright structures; Doppler beaming makes approaching material brighter. [NASA visualization](https://svs.gsfc.nasa.gov/13326/)
- Gravity changes light's direction and frequency; locally measured vacuum light speed remains constant. Treating photons as ever-accelerating spiral particles is misleading. [NASA light and gravity](https://science.gsfc.nasa.gov/attic/cosmicopia.gsfc.nasa.gov/qa_sp_en.html)
- A distant observer sees infalling emission slow, redden and dim near the horizon. Locally, the infalling object crosses in finite proper time. [NASA horizon visualization](https://science.nasa.gov/universe/black-holes/new-nasa-black-hole-visualization-takes-viewers-beyond-the-brink/), [NASA observer comparison](https://imagine.gsfc.nasa.gov/educators/blackholes/imagine/page8.html)
- Tidal gravity stretches matter radially and compresses it transversely. This is distinct from an optical image being stretched into an arc by lensing. [NASA tidal forces](https://science.nasa.gov/universe/what-happens-when-something-gets-too-close-to-a-black-hole/)

## Translation into the product visual

Code represents luminous, orbiting source material viewed through a simplified lensing projection. It does not represent a stream of individual photons.

`web/src/auth/code-accretion-physics.ts` integrates a dimensionless radius and azimuth. All entry lanes carry the same angular-momentum sign. Left and right streams start at different azimuths, inclinations and small entry offsets, then join a common inward spiral. The projected disk is nearly edge-on. Its far side bends into the upper arc; a much weaker mirrored image suggests a second light path below the shadow.

The outer orbital law uses `omega ∝ r^(-3/2)` and a prescribed slow radial drift. Radial drift strengthens inside an artistic capture region. A lapse-like timing factor reduces apparent motion in the final segment, alongside exponential dimming and an orange-red tint. Brightness varies by approaching/receding orbital phase.

Code is warped strip by strip along its projected track. Shear and transverse compression increase inward, using an inverse-cube field-strength proxy. This produces an illustrative lensed ribbon; it is not a solved tidal tensor or a measurement of how physical text would stretch. The cached glow deforms with its source glyphs. At the disk's left and right turning points the ribbon tangent runs vertical; a short fade there hides the strip flip, so the code sinks into the bright limb and re-emerges upright instead of shivering.

## Limits

The artwork's apparent shadow radius sets the scene scale; it is **not** the physical event-horizon radius. Capture thresholds, viewing inclination, spectral tint, drift rate and animation duration are art-directed. The model does not integrate null geodesics, solve a Kerr metric, ray trace a volumetric plasma, conserve fluid angular momentum through a viscosity model, or calculate a physical emission spectrum. The lower image is a compositional approximation without a light-travel-time solution. The scientific references motivate qualitative behavior rather than establish numerical accuracy.
