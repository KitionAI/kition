// Copied from kition-sdk packages/sdk/kits/cube.ts by scripts/sync-kit-host.mjs; change it there, not here.
// 6) and its command catalogue. Do not edit; regenerate it.
import type { CommandMap, ModelDocument, ModelList, ModelMap, ModelObject, ModelText, ModelTree, RequestContext } from '../index'
import { registerKit, type KitDescriptor } from '../kits'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type BlobRef = { hash: string; mime: string; size: number }

/** kit.cube: registered with @kition/sdk when this module loads. */
export const cubeKit: KitDescriptor = registerKit({ id: "kit.cube", schema: {"kdm":1,"kit":"kit.cube","schemaVersion":6,"root":"Scene","types":{"Scene":{"fields":{"objects":{"kind":"list","of":"Object"},"materials":{"kind":"list","of":"Material"},"images":{"kind":"list","of":"Image"},"world":{"kind":"json"},"render":{"kind":"json"},"camera":{"kind":"integer","optional":true},"timeline":{"kind":"json"},"physics":{"kind":"json","optional":true},"actions":{"kind":"json","optional":true},"keyingSets":{"kind":"json","optional":true},"keys":{"kind":"map"}}},"Object":{"fields":{"key":{"kind":"integer"},"name":{"kind":"string"},"kind":{"kind":"enum","values":["mesh","light","camera","empty","armature","curve","text","lattice"]},"data":{"kind":"json"},"mesh":{"kind":"blob","optional":true},"location":{"kind":"json"},"rotation":{"kind":"json"},"scale":{"kind":"json"},"parent":{"kind":"integer","optional":true},"parentInverse":{"kind":"json","optional":true},"hidden":{"kind":"boolean"},"material":{"kind":"integer","optional":true},"modifiers":{"kind":"json"},"constraints":{"kind":"json","optional":true},"physics":{"kind":"json","optional":true},"particles":{"kind":"json","optional":true},"hair":{"kind":"blob","optional":true},"animation":{"kind":"json"},"nla":{"kind":"json","optional":true},"tweak":{"kind":"json","optional":true}}},"Material":{"fields":{"key":{"kind":"integer"},"name":{"kind":"string"},"data":{"kind":"json"},"animation":{"kind":"json"}}},"NodeGroup":{"fields":{"key":{"kind":"integer"},"name":{"kind":"string"},"tree":{"kind":"string","optional":true},"inputs":{"kind":"json","optional":true},"outputs":{"kind":"json","optional":true},"nodes":{"kind":"list","of":"Node"},"links":{"kind":"list","of":"Link"}}},"Node":{"fields":{"key":{"kind":"integer"},"kind":{"kind":"string"},"location":{"kind":"json"},"values":{"kind":"map"}}},"Link":{"fields":{"from":{"kind":"integer"},"fromSocket":{"kind":"string"},"to":{"kind":"integer"},"toSocket":{"kind":"string"}}},"Image":{"fields":{"hash":{"kind":"string"},"name":{"kind":"string"},"format":{"kind":"string"},"bytes":{"kind":"blob"}}}}} })

/** The fields a new `Scene` takes (`list.add(fields)`). */
export type SceneFields = {
  world: Json
  render: Json
  camera?: number | null
  timeline: Json
  physics?: Json | null
  actions?: Json | null
  keyingSets?: Json | null
}

/** A `Scene` of kit.cube. */
export interface Scene extends ModelObject {
  readonly objects: ModelList<Object, ObjectFields>
  readonly materials: ModelList<Material, MaterialFields>
  readonly images: ModelList<Image, ImageFields>
  world: Json
  render: Json
  camera: number | null
  timeline: Json
  physics: Json | null
  actions: Json | null
  keyingSets: Json | null
  readonly keys: ModelMap<Json>
}

/** The fields a new `Object` takes (`list.add(fields)`). */
export type ObjectFields = {
  key: number
  name: string
  kind: "mesh" | "light" | "camera" | "empty" | "armature" | "curve" | "text" | "lattice"
  data: Json
  mesh?: BlobRef | null
  location: Json
  rotation: Json
  scale: Json
  parent?: number | null
  parentInverse?: Json | null
  hidden: boolean
  material?: number | null
  modifiers: Json
  constraints?: Json | null
  physics?: Json | null
  particles?: Json | null
  hair?: BlobRef | null
  animation: Json
  nla?: Json | null
  tweak?: Json | null
}

/** A `Object` of kit.cube. */
export interface Object extends ModelObject {
  key: number
  name: string
  kind: "mesh" | "light" | "camera" | "empty" | "armature" | "curve" | "text" | "lattice"
  data: Json
  mesh: BlobRef | null
  location: Json
  rotation: Json
  scale: Json
  parent: number | null
  parentInverse: Json | null
  hidden: boolean
  material: number | null
  modifiers: Json
  constraints: Json | null
  physics: Json | null
  particles: Json | null
  hair: BlobRef | null
  animation: Json
  nla: Json | null
  tweak: Json | null
}

/** The fields a new `Material` takes (`list.add(fields)`). */
export type MaterialFields = {
  key: number
  name: string
  data: Json
  animation: Json
}

/** A `Material` of kit.cube. */
export interface Material extends ModelObject {
  key: number
  name: string
  data: Json
  animation: Json
}

/** The fields a new `NodeGroup` takes (`list.add(fields)`). */
export type NodeGroupFields = {
  key: number
  name: string
  tree?: string | null
  inputs?: Json | null
  outputs?: Json | null
}

/** A `NodeGroup` of kit.cube. */
export interface NodeGroup extends ModelObject {
  key: number
  name: string
  tree: string | null
  inputs: Json | null
  outputs: Json | null
  readonly nodes: ModelList<Node, NodeFields>
  readonly links: ModelList<Link, LinkFields>
}

/** The fields a new `Node` takes (`list.add(fields)`). */
export type NodeFields = {
  key: number
  kind: string
  location: Json
}

/** A `Node` of kit.cube. */
export interface Node extends ModelObject {
  key: number
  kind: string
  location: Json
  readonly values: ModelMap<Json>
}

/** The fields a new `Link` takes (`list.add(fields)`). */
export type LinkFields = {
  from: number
  fromSocket: string
  to: number
  toSocket: string
}

/** A `Link` of kit.cube. */
export interface Link extends ModelObject {
  from: number
  fromSocket: string
  to: number
  toSocket: string
}

/** The fields a new `Image` takes (`list.add(fields)`). */
export type ImageFields = {
  hash: string
  name: string
  format: string
  bytes: BlobRef
}

/** A `Image` of kit.cube. */
export interface Image extends ModelObject {
  hash: string
  name: string
  format: string
  bytes: BlobRef
}

/** Every command of kit.cube, by id, with its parameters. */
export interface CubeCommands extends CommandMap {
  /** Undo. Takes back the caller's last edit (the person's, or the agent's with `scope: "agent"`), leaving the other's edits in place. Changes the document. */
  "edit.undo": { /** Whose steps to undo */ scope?: "person" | "agent" }
  /** Redo. Applies again the edit the caller's last undo took back, in the same scope as `edit.undo`. Changes the document. */
  "edit.redo": { /** Whose steps to redo */ scope?: "person" | "agent" }
  /** Delete. Deletes `objects` (names or ids; the selection without it) from the scene. Changes the document. */
  "edit.delete": { /** Object mode: the objects to delete; the selection when left out. Edit mode deletes the selected faces or vertices */ objects?: Json }
  /** Duplicate. Duplicates the selected objects, moved by `offset`, and selects the copies. Changes the document. */
  "edit.duplicate": { /** Move the copies by this much, in metres [x, y, z] */ offset?: Array<number> }
  /** Select All. Selects every object in object mode (or every element in edit mode); `action: "toggle"`/`"deselect"` changes that. Answers whether the selection changed. */
  "select.all": { /** What to do */ action?: "select" | "deselect" | "invert" }
  /** Select None. Clears the selection. Answers whether it changed. */
  "select.none": Record<string, never>
  /** Select Objects. Selects the objects in `objects` (names or ids), adding with `extend` or removing with `deselect`, for selection-based commands. */
  "select.objects": { /** Take them out of the selection */ deselect?: boolean; /** Add to the selection instead of replacing it */ extend?: boolean; /** The objects to select */ objects: Json }
  /** Plane. Adds a plane mesh of `size` at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.plane": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Side length in metres (2) */ size?: number }
  /** Cube. Adds a cube mesh of `size` at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.cube": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Side length in metres (2) */ size?: number }
  /** Circle. Adds a circle mesh of `radius` and vertex count, optionally filled at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.circle": { /** How to fill it */ fill?: "nothing" | "ngon" | "triangleFan"; /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Radius in metres (1) */ radius?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Vertices (32) */ vertices?: number }
  /** UV Sphere. Adds a UV sphere mesh of `radius` with segments and rings at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.uvSphere": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Radius in metres (1) */ radius?: number; /** Rings from pole to pole (16) */ rings?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Segments around (32) */ segments?: number }
  /** Ico Sphere. Adds a icosphere mesh of `radius` and subdivision level at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.icoSphere": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Radius in metres (1) */ radius?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Subdivisions, 1 to 8 (2) */ subdivisions?: number }
  /** Cylinder. Adds a cylinder mesh of `radius` and `depth` at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.cylinder": { /** Height in metres (2) */ depth?: number; /** How the ends are closed */ fill?: "nothing" | "ngon" | "triangleFan"; /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Radius in metres (1) */ radius?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Vertices around (32) */ vertices?: number }
  /** Cone. Adds a cone mesh with bottom and top radii and `depth` at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.cone": { /** Height in metres (2) */ depth?: number; /** How the ends are closed */ fill?: "nothing" | "ngon" | "triangleFan"; /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Bottom radius in metres (1) */ radius1?: number; /** Top radius in metres (0) */ radius2?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Vertices around (32) */ vertices?: number }
  /** Torus. Adds a torus mesh with major and minor radii and segments at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.torus": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** Ring radius in metres (1) */ majorRadius?: number; /** Segments around the ring (48) */ majorSegments?: number; /** Tube radius in metres (0.25) */ minorRadius?: number; /** Segments around the tube (12) */ minorSegments?: number; /** The object's name */ name?: string; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number> }
  /** Grid. Adds a grid mesh of `size` with x and y subdivisions at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.grid": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Side length in metres (2) */ size?: number; /** Faces along X (10) */ xSubdivisions?: number; /** Faces along Y (10) */ ySubdivisions?: number }
  /** Light. Adds a light (point, sun, spot or area) with color and power at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.light": { /** Colour */ color?: Json; /** The kind of light */ kind?: "point" | "sun" | "spot" | "area"; /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Watts (W/m? for a sun) */ power?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number> }
  /** Camera. Adds a camera with a lens in millimetres at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.camera": { /** Focal length in millimetres (50) */ lens?: number; /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number> }
  /** Empty. Adds a empty (an axis marker for parenting and targets) at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.empty": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** Axis length in metres (1) */ size?: number }
  /** Set Transform. Sets location, rotation (degrees) and/or scale of `objects` (names or ids; the selection without it) absolutely. Changes the document. */
  "object.transform": { /** Location in metres [x, y, z] */ location?: Array<number>; /** The objects; the selection when left out */ objects?: Json; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number> }
  /** Move. Moves `objects` (names or ids; the selection without it) by `offset` [x, y, z]. Changes the document. */
  "object.translate": { /** The objects; the selection when left out */ objects?: Json; /** How far, in metres [x, y, z] */ offset: Array<number> }
  /** Rotate. Rotates `objects` (names or ids; the selection without it) by `angle` degrees about `axis` (x, y or z). Changes the document. */
  "object.rotate": { /** Degrees, counter-clockwise looking down the axis */ angle: number; /** The world axis to turn about */ axis: "x" | "y" | "z"; /** The objects; the selection when left out */ objects?: Json }
  /** Scale. Scales `objects` (names or ids; the selection without it) by `factor` (a number or [x, y, z]). Changes the document. */
  "object.scale": { /** A number, or [x, y, z] */ factor: Json; /** The objects; the selection when left out */ objects?: Json }
  /** Apply Transform. Bakes the location, rotation and/or scale of `objects` (names or ids; the selection without it) into the mesh data and resets them. Changes the document. */
  "object.applyTransform": { /** Apply the location (false) */ location?: boolean; /** The objects; the selection when left out */ objects?: Json; /** Apply the rotation (true) */ rotation?: boolean; /** Apply the scale (true) */ scale?: boolean }
  /** Origin to Geometry. Moves the origin of `objects` (names or ids; the selection without it) to the centre of their geometry without moving the geometry. Changes the document. */
  "object.originToGeometry": { /** The objects; the selection when left out */ objects?: Json }
  /** Move in Outliner. Moves `object` to position `index` among its siblings in the outliner. Changes the document. */
  "object.order": { /** Its new place in the outliner, from 0 */ index: number; /** The object to move */ object: Json }
  /** Rename. Renames `object` (name or id) to `name`. Changes the document. */
  "object.rename": { /** The new name */ name: string; /** The object; the active one when left out */ object?: Json }
  /** Parent. Parents `objects` (names or ids; the selection without it) to `parent`, keeping their world transform. Changes the document. */
  "object.parent": { /** The children; the selection without the active object when left out */ objects?: Json; /** The parent; the active object when left out */ parent?: Json }
  /** Clear Parent. Clears the parent of `objects` (names or ids; the selection without it), keeping their world transform. Changes the document. */
  "object.clearParent": { /** The objects; the selection when left out */ objects?: Json }
  /** Hide. Hides `objects` (names or ids; the selection without it) in the viewport and renders. Changes the document. */
  "object.hide": { /** The objects; the selection when left out */ objects?: Json }
  /** Show Hidden. Shows `objects` (names or ids; the selection without it) again, or every hidden object without it. Changes the document. */
  "object.reveal": { /** The hidden objects to show; every hidden object when left out */ objects?: Json }
  /** Shade Smooth. Shades the meshes of `objects` (names or ids; the selection without it) smooth. Changes the document. */
  "object.shadeSmooth": { /** The objects; the selection when left out */ objects?: Json }
  /** Shade Flat. Shades the meshes of `objects` (names or ids; the selection without it) flat. Changes the document. */
  "object.shadeFlat": { /** The objects; the selection when left out */ objects?: Json }
  /** Join. Joins the selected meshes into the active one. Changes the document. */
  "object.join": Record<string, never>
  /** Set Active Camera. Makes camera `object` the scene's active camera for renders. Changes the document. */
  "object.setCamera": { /** The camera; the active object when left out */ object?: Json }
  /** Look At. Rotates `object` so it points at `target` [x, y, z] (cameras and lights look along -Z). Changes the document. */
  "object.lookAt": { /** The object to turn (a camera or a light); the active one when left out */ object?: Json; /** The point to look at, in metres [x, y, z] */ target: Array<number> }
  /** Toggle Edit Mode. Toggles the active mesh between object mode and edit mode. */
  "mode.toggle": Record<string, never>
  /** Set Mode. Sets object or edit mode for `object` (else the active object). Edit-mode mesh commands need `mode: "edit"` first. */
  "mode.set": { /** The mode */ mode: "object" | "edit"; /** The mesh to edit; the active one when left out */ object?: Json }
  /** Select Mode. Sets edit mode's element selection to vertices, edges or faces. */
  "mesh.selectMode": { /** What clicks select */ mode: "vertex" | "edge" | "face" }
  /** Vertex Select. Switches edit mode to vertex selection. */
  "mesh.selectVertexMode": Record<string, never>
  /** Edge Select. Switches edit mode to edge selection. */
  "mesh.selectEdgeMode": Record<string, never>
  /** Face Select. Switches edit mode to face selection. */
  "mesh.selectFaceMode": Record<string, never>
  /** Select Elements. Selects vertices and/or faces of the edited mesh by index (or all), adding with `extend` or removing with `deselect`. */
  "mesh.select": { /** Take them out of the selection */ deselect?: boolean; /** Add to the selection instead of replacing it */ extend?: boolean; /** Face indices (selects their vertices) */ faces?: Array<number>; /** Vertex indices */ vertices?: Array<number> }
  /** Extrude Faces. Extrudes the selected faces along their normals by `distance` (or by `offset`), in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.extrude": { /** How far along the faces' mean normal, in metres (1) */ distance?: number; /** An extra offset in metres [x, y, z] */ offset?: Array<number> }
  /** Inset Faces. Insets the selected faces by `thickness`, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.inset": { /** How far in, in metres (0.1) */ thickness?: number }
  /** Bevel Edges. Bevels the selected edges with `width` and `segments`, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.bevel": { /** Segments across the bevel (1) */ segments?: number; /** The bevel's width in metres (0.1) */ width?: number }
  /** Subdivide. Subdivides the selected edges and faces, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.subdivide": Record<string, never>
  /** Loop Cut. Adds `cuts` edge loops across the ring of edge `edge` [vertex, vertex] at `factor` in the edited mesh. Changes the document. */
  "mesh.loopCut": { /** Number of loops (1) */ cuts?: number; /** The edge the cut crosses, as [vertex, vertex] */ edge: Array<number>; /** Where a single loop goes between the sides, 0 to 1 (0.5) */ factor?: number }
  /** Merge at Center. Merges the selected vertices at their centre, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.merge": Record<string, never>
  /** Delete Faces. Deletes the selected faces, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.deleteFaces": Record<string, never>
  /** Delete Vertices. Deletes the selected vertices and the faces using them, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.deleteVertices": Record<string, never>
  /** Fill Face. Makes a face from the vertices in `vertices` (else the selection) of the edited mesh. Changes the document. */
  "mesh.fill": { /** The face's corners in order; the selection when left out */ vertices?: Array<number> }
  /** Flip Normals. Flips the normals of the selected faces, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.flip": Record<string, never>
  /** Recalculate Outside. Recalculates the normals of `objects` (names or ids; the selection without it) so they point outside. Changes the document. */
  "mesh.recalculateNormals": { /** Object mode: the mesh objects to turn outward; the selection when left out. Edit mode works on the edited mesh */ objects?: Json }
  /** Move Elements. Moves the selected elements by `offset`, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.translate": { /** How far in the object's own axes, in metres [x, y, z] */ offset: Array<number> }
  /** Scale Elements. Scales the selected elements by `factor` about `pivot`, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.scale": { /** A number, or [x, y, z] */ factor: Json; /** The point to scale about; the selection's centre when left out [x, y, z] */ pivot?: Array<number> }
  /** Set Geometry. Replaces the mesh of `object` with `positions` and `faces` (vertex index lists), optionally smooth-shaded. Changes the document. */
  "mesh.setGeometry": { /** Faces as lists of vertex indices, counter-clockwise seen from outside */ faces: Array<Json>; /** The mesh object; the active one when left out */ object?: Json; /** Vertex positions as [x, y, z], in the object's own axes */ positions: Array<Json>; /** Smooth shading */ smooth?: boolean }
  /** Add Modifier. Adds a modifier (subdivision, mirror, array, bevel, solidify, boolean, displace, ...) with its settings to `object`. Changes the document. */
  "modifier.add": { /** screw: degrees to turn */ angle?: number; /** bevel: edges sharper than this many degrees are bevelled; decimate planar: faces flatter than this join (5) */ angleLimit?: number; /** mirror: [x, y, z] axes to mirror across */ axes?: Array<boolean>; /** screw and simpleDeform: the local axis */ axis?: "x" | "y" | "z"; /** array: an extra offset in metres [x, y, z] */ constantOffset?: Array<number>; /** displace: where the image is looked up (local: -1 to 1 in object axes covers it once) */ coordinates?: "local" | "global" | "uv"; /** array: the number of copies */ count?: number; /** displace: where to push */ direction?: "normal" | "x" | "y" | "z"; /** weld: the distance that joins vertices */ distance?: number; /** armature: vertices in no bone's group follow the bones whose envelopes reach them (false) */ envelopes?: boolean; /** smooth: how far each vertex moves towards its neighbours */ factor?: number; /** geometryNodes: the node group's id (nodes.newGroup makes one) */ group?: number; /** displace: an image's hash (from image.add) whose brightness pushes; null for none */ image?: string; /** geometryNodes: the group's inputs by name */ inputs?: { [key: string]: Json }; /** armature: use one minus that group's weights */ invertVertexGroup?: boolean; /** decimate unsubdivide: half steps of subdivision to undo, 0 to 16 */ iterations?: number; /** subdivision: levels, 0 to 6; multires: the level shown (at most the mesh's levels) */ levels?: number; /** simpleDeform: [low, high], the share of the range that deforms, 0 to 1 */ limits?: Array<number>; /** mirror and array: join vertices where copies meet */ merge?: boolean; /** mirror: the distance that joins vertices on the plane */ mergeThreshold?: number; /** displace: the value that does not move (0.5) */ midLevel?: number; /** simpleDeform: what it does; decimate: collapse, unsubdivide, or planar */ mode?: "twist" | "bend" | "taper" | "stretch" | "collapse" | "unsubdivide" | "planar"; /** armature: deform what the Armature modifier above got and mix over its result by the group */ multiModifier?: boolean; /** shrinkwrap project: cast against it (false) */ negative?: boolean; /** displace: noise feature size in metres; 0 pushes every vertex alike */ noiseScale?: number; /** The mesh object; the active one when left out */ object?: Json; /** solidify: -1 grows inwards, 1 outwards; wireframe: -1 to 1; shrinkwrap: metres kept from the surface */ offset?: number; /** boolean and shrinkwrap: the other mesh object; lattice: the lattice object */ operand?: Json; /** boolean: what to keep */ operation?: "difference" | "union" | "intersect"; /** shrinkwrap project: cast along the vertex normal (true) */ positive?: boolean; /** armature: blend the bones as dual quaternions, so joints keep their volume (false) */ preserveVolume?: boolean; /** decimate collapse: the share of triangles to keep, 0 to 1 */ ratio?: number; /** array: the offset between copies as a fraction of the mesh size [x, y, z] */ relativeOffset?: Array<number>; /** solidify: close the open edges */ rim?: boolean; /** screw: how far along the axis one turn moves, metres */ screwOffset?: number; /** multires: the level sculpt mode shows and sculpts */ sculptLevels?: number; /** bevel: segments across each bevel (1 is a flat chamfer) */ segments?: number; /** screw: steps around one turn */ steps?: number; /** displace: how far, in metres, at full value; lattice: how much of the bend (1) */ strength?: number; /** solidify: the shell's thickness in metres */ thickness?: number; /** The modifier */ type: "mirror" | "array" | "subdivision" | "solidify" | "triangulate" | "weld" | "smooth" | "bevel" | "boolean" | "screw" | "displace" | "decimate" | "wireframe" | "simpleDeform" | "cast" | "multires" | "shrinkwrap" | "lattice" | "geometryNodes"; /** armature: a group whose weights say how much of the deformation each vertex takes; null for all */ vertexGroup?: string; /** armature: vertices follow the bones of their groups (true) */ vertexGroups?: boolean; /** bevel: the bevel's width in metres */ width?: number; /** shrinkwrap: where vertices go */ wrapMethod?: "nearestSurface" | "project" | "nearestVertex" }
  /** Change Modifier. Changes the settings of modifier `index` or `name` on `object`. Changes the document. */
  "modifier.set": { /** screw: degrees to turn */ angle?: number; /** bevel: edges sharper than this many degrees are bevelled; decimate planar: faces flatter than this join (5) */ angleLimit?: number; /** mirror: [x, y, z] axes to mirror across */ axes?: Array<boolean>; /** screw and simpleDeform: the local axis */ axis?: "x" | "y" | "z"; /** array: an extra offset in metres [x, y, z] */ constantOffset?: Array<number>; /** displace: where the image is looked up (local: -1 to 1 in object axes covers it once) */ coordinates?: "local" | "global" | "uv"; /** array: the number of copies */ count?: number; /** displace: where to push */ direction?: "normal" | "x" | "y" | "z"; /** weld: the distance that joins vertices */ distance?: number; /** Shown in the viewport and renders */ enabled?: boolean; /** armature: vertices in no bone's group follow the bones whose envelopes reach them (false) */ envelopes?: boolean; /** smooth: how far each vertex moves towards its neighbours */ factor?: number; /** geometryNodes: the node group's id (nodes.newGroup makes one) */ group?: number; /** displace: an image's hash (from image.add) whose brightness pushes; null for none */ image?: string; /** The modifier's position in the stack, from 0 */ index?: number; /** geometryNodes: the group's inputs by name */ inputs?: { [key: string]: Json }; /** armature: use one minus that group's weights */ invertVertexGroup?: boolean; /** decimate unsubdivide: half steps of subdivision to undo, 0 to 16 */ iterations?: number; /** subdivision: levels, 0 to 6; multires: the level shown (at most the mesh's levels) */ levels?: number; /** simpleDeform: [low, high], the share of the range that deforms, 0 to 1 */ limits?: Array<number>; /** mirror and array: join vertices where copies meet */ merge?: boolean; /** mirror: the distance that joins vertices on the plane */ mergeThreshold?: number; /** displace: the value that does not move (0.5) */ midLevel?: number; /** simpleDeform: what it does; decimate: collapse, unsubdivide, or planar */ mode?: "twist" | "bend" | "taper" | "stretch" | "collapse" | "unsubdivide" | "planar"; /** armature: deform what the Armature modifier above got and mix over its result by the group */ multiModifier?: boolean; /** The modifier's name (instead of index) */ name?: string; /** shrinkwrap project: cast against it (false) */ negative?: boolean; /** displace: noise feature size in metres; 0 pushes every vertex alike */ noiseScale?: number; /** The mesh object; the active one when left out */ object?: Json; /** solidify: -1 grows inwards, 1 outwards; wireframe: -1 to 1; shrinkwrap: metres kept from the surface */ offset?: number; /** boolean and shrinkwrap: the other mesh object; lattice: the lattice object */ operand?: Json; /** boolean: what to keep */ operation?: "difference" | "union" | "intersect"; /** shrinkwrap project: cast along the vertex normal (true) */ positive?: boolean; /** armature: blend the bones as dual quaternions, so joints keep their volume (false) */ preserveVolume?: boolean; /** decimate collapse: the share of triangles to keep, 0 to 1 */ ratio?: number; /** array: the offset between copies as a fraction of the mesh size [x, y, z] */ relativeOffset?: Array<number>; /** A new name */ rename?: string; /** solidify: close the open edges */ rim?: boolean; /** screw: how far along the axis one turn moves, metres */ screwOffset?: number; /** multires: the level sculpt mode shows and sculpts */ sculptLevels?: number; /** bevel: segments across each bevel (1 is a flat chamfer) */ segments?: number; /** screw: steps around one turn */ steps?: number; /** displace: how far, in metres, at full value; lattice: how much of the bend (1) */ strength?: number; /** solidify: the shell's thickness in metres */ thickness?: number; /** armature: a group whose weights say how much of the deformation each vertex takes; null for all */ vertexGroup?: string; /** armature: vertices follow the bones of their groups (true) */ vertexGroups?: boolean; /** bevel: the bevel's width in metres */ width?: number; /** shrinkwrap: where vertices go */ wrapMethod?: "nearestSurface" | "project" | "nearestVertex" }
  /** Remove Modifier. Removes modifier `index` or `name` from `object`. Changes the document. */
  "modifier.remove": { /** The modifier's position in the stack, from 0 */ index?: number; /** The modifier's name (instead of index) */ name?: string; /** The mesh object; the active one when left out */ object?: Json }
  /** Apply Modifier. Applies modifier `index` or `name` to `object`'s mesh and removes it. Changes the document. */
  "modifier.apply": { /** The modifier's position in the stack, from 0 */ index?: number; /** The modifier's name (instead of index) */ name?: string; /** The mesh object; the active one when left out */ object?: Json }
  /** Move Modifier. Moves modifier `index` or `name` to position `to` in `object`'s stack. Changes the document. */
  "modifier.move": { /** The modifier's position in the stack, from 0 */ index?: number; /** The modifier's name (instead of index) */ name?: string; /** The mesh object; the active one when left out */ object?: Json; /** The new position, from 0 */ to: number }
  /** New Material. Creates a material with base color, metallic and roughness and answers its id; `assign: true` assigns it to the selection. Changes the document. */
  "material.new": { /** Give it to the selected objects (true) */ assign?: boolean; /** Base colour */ baseColor?: Json; /** 0 to 1 */ metallic?: number; /** The material's name */ name?: string; /** 0 to 1 */ roughness?: number }
  /** Change Material. Changes material `material` (name or id): base color, metallic, roughness, emission, alpha, transmission and more. Changes the document. */
  "material.set": { /** clip: the alpha below which the surface is not there (0.5) */ alphaCutoff?: number; /** How the base colour's alpha is used */ alphaMode?: "opaque" | "clip" | "blend"; /** Base colour */ baseColor?: Json; /** Emission colour */ emission?: Json; /** Emission strength */ emissionStrength?: number; /** Index of refraction (1.5) */ ior?: number; /** The material's id or name */ material: Json; /** 0 to 1 */ metallic?: number; /** A new name */ name?: string; /** How strongly the normal map bends the surface (1) */ normalStrength?: number; /** 0 to 1 */ roughness?: number; /** A shader group (id or name) giving the surface and volume in path-traced renders, or null to let go of it */ shader?: Json; /** How much light passes through, 0 to 1 (glass at 1) */ transmission?: number }
  /** Assign Material. Assigns material `material` to `objects` (names or ids; the selection without it). Changes the document. */
  "material.assign": { /** The material's id or name */ material: Json; /** The objects; the selection when left out */ objects?: Json }
  /** Remove Material. Removes the materials from `objects` (names or ids; the selection without it). Changes the document. */
  "material.clear": { /** The objects; the selection when left out */ objects?: Json }
  /** Delete Material. Deletes material `material`; refused while objects use it unless `force`. Changes the document. */
  "material.delete": { /** Delete it even though objects use it; they are left without a material (false) */ force?: boolean; /** The material's id or name */ material: Json }
  /** Light Settings. Changes light `object` (else the selected light): kind, color, power, radius, spot size. Changes the document. */
  "light.set": { /** Colour */ color?: Json; /** The kind of light */ kind?: "point" | "sun" | "spot" | "area"; /** The light; the active object when left out */ object?: Json; /** Watts (W/m? for a sun) */ power?: number; /** Soft shadow radius in metres */ radius?: number; /** Spot cone angle in degrees */ spotSize?: number }
  /** Camera Settings. Changes camera `object`: lens, clipping, sensor, depth of field, aperture blades. Changes the document. */
  "camera.set": { /** The blades' turn in degrees (0) */ bladeRotation?: number; /** The opening's blades: 0 for round (the default), 3 to 64 for a polygon */ blades?: number; /** Farthest distance drawn, metres */ clipEnd?: number; /** Nearest distance drawn, metres */ clipStart?: number; /** Blur what is out of focus in path-traced renders */ depthOfField?: boolean; /** Aperture as an f-number (2.8); smaller blurs more */ fStop?: number; /** Metres in front of the camera that are sharp (10) */ focusDistance?: number; /** An object to keep in focus (an id or a name), or null for the distance */ focusObject?: Json; /** Focal length in millimetres */ lens?: number; /** The camera; the active object when left out */ object?: Json; /** Width an orthographic camera sees, metres */ orthoScale?: number; /** Orthographic instead of perspective */ orthographic?: boolean; /** The opening's height over its width for anamorphic bokeh (1); above 1 narrows it */ ratio?: number; /** Sensor width in millimetres */ sensor?: number }
  /** World Settings. Sets the world background color and strength, rotation and volume. Changes the document. */
  "world.set": { /** Background colour */ color?: Json; /** Degrees the world image is turned about the up axis */ rotation?: number; /** How strongly it (or its image) lights the scene */ strength?: number; /** A shader group (id or name) whose Volume fills the world in path-traced renders, or null for none */ volume?: Json }
  /** Render Settings. Sets render width and height, motion blur and shutter. Changes the document. */
  "render.set": { /** Pixels */ height?: number; /** Blur what moves while the shutter is open, in path-traced renders */ motionBlur?: boolean; /** How long the shutter is open, in frames (0.5) */ shutter?: number; /** Where the shutter opens around the frame (center) */ shutterPosition?: "center" | "start" | "end"; /** Pixels */ width?: number }
  /** Render Image. Renders the active camera's view (at `frame`, with `samples`) and answers it as a base64 PNG with its size. Does not change the scene. */
  "render.image": { /** The frame to render (the current frame when left out) */ frame?: number; /** Samples per pixel side, 1 to 4 (2) */ samples?: number }
  /** Export. Exports the scene (or `selectedOnly`) as glTF/GLB, OBJ, STL, FBX, USD (usda, usdc, usdz) or a PNG render and answers the file as base64. Does not change the scene. */
  "file.export": { /** The file format */ format: "glb" | "gltf" | "obj" | "stl" | "fbx" | "usda" | "usdc" | "usdz" | "png"; /** png: the frame to render (the current frame when left out) */ frame?: number; /** png: samples per pixel side, 1 to 4 (2) */ samples?: number; /** Only the selected objects */ selectedOnly?: boolean }
  /** Import. Imports a glTF/GLB, OBJ, STL, FBX, USD or .blend file from the workspace (`path`) or base64 into the scene. Changes the document. */
  "file.import": { /** The file's bytes, instead of a path */ base64?: string; /** The format of base64 bytes */ format?: "glb" | "gltf" | "obj" | "stl" | "fbx" | "usd" | "usda" | "usdc" | "usdz" | "blend"; /** A .glb, .gltf, .obj, .stl, .fbx, .usd, .usda, .usdc, .usdz, or .blend file, relative to this scene's folder */ path?: Json }
  /** Viewport Shading. Sets the viewport shading to wireframe, solid, material preview or rendered. */
  "view.shading": { /** How surfaces are drawn */ mode: "wireframe" | "solid" | "material" | "rendered" }
  /** Wireframe. Sets the viewport shading to wireframe. */
  "view.wireframe": Record<string, never>
  /** Solid. Sets the viewport shading to solid. */
  "view.solid": Record<string, never>
  /** Material Preview. Sets the viewport shading to material preview. */
  "view.material": Record<string, never>
  /** Rendered. Shows progressive path tracing of the viewport with scene lights, materials and editor overlays. */
  "view.rendered": Record<string, never>
  /** Continue Rendered Viewport. Advances the rendered viewport in bounded worker steps; a headless caller can wait for the completed preview. Sampling never changes the document or undo history. */
  "view.renderedStep": { /** Worker time budget in milliseconds, clamped to 1 to 32 (8) */ budgetMs?: number; /** Samples per preview pixel, 1 to 256 (32); changing this retains the compiled scene */ samples?: number; /** Finish the preview before answering, for headless callers (false) */ wait?: boolean }
  /** Front. Looks at the scene from the front. */
  "view.front": Record<string, never>
  /** Right. Looks at the scene from the right. */
  "view.right": Record<string, never>
  /** Top. Looks at the scene from the top. */
  "view.top": Record<string, never>
  /** Camera. Looks through the active camera. */
  "view.camera": Record<string, never>
  /** Perspective/Orthographic. Toggles the viewport between perspective and orthographic. */
  "view.perspective": Record<string, never>
  /** Frame All. Frames every object in the viewport. */
  "view.frameAll": Record<string, never>
  /** Frame Selected. Frames the selected objects in the viewport. */
  "view.frameSelected": Record<string, never>
  /** Grid Floor. Shows or hides the grid floor in the viewport. */
  "view.grid": { /** Show the grid; toggles when left out */ on?: boolean }
  /** Orbit. Orbits the viewport by `turn` and `tilt` degrees. */
  "view.orbit": { /** Degrees up or down */ tilt?: number; /** Degrees about the up axis */ turn?: number }
  /** Pan. Pans the viewport by `right` and `up`. */
  "view.pan": { /** Fraction of the view's height */ right?: number; /** Fraction of the view's height */ up?: number }
  /** Zoom. Zooms the viewport by `factor` (above 1 zooms in). */
  "view.zoom": { /** Below 1 moves closer, above 1 farther */ factor: number }
  /** Set View. Sets the viewport's target, distance, turn, tilt and projection at once. */
  "view.set": { /** Metres from the target */ distance?: number; /** Perspective or orthographic */ perspective?: boolean; /** The point the view turns around [x, y, z] */ target?: Array<number>; /** Degrees: 0 looks down, 90 level */ tilt?: number; /** Degrees about the up axis */ turn?: number }
  /** Resize View. Sets the viewport size in pixels, which previews and the camera view use. */
  "view.resize": { /** Pixels */ height: number; /** Pixels */ width: number }
  /** Extrude Individual Faces. Extrudes each selected face separately along its own normal by `distance`, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.extrudeIndividual": { /** How far each face moves along its own normal, metres (1) */ distance?: number }
  /** Dissolve Vertices. Dissolves the selected vertices, merging the faces around them, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.dissolveVertices": Record<string, never>
  /** Dissolve Edges. Dissolves the selected edges, merging the faces on both sides, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.dissolveEdges": Record<string, never>
  /** Dissolve Faces. Dissolves the selected faces into one face, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.dissolveFaces": Record<string, never>
  /** Bridge Edge Loops. Bridges two selected edge loops with faces, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.bridge": Record<string, never>
  /** Bisect. Cuts the edited mesh along the plane through `point` with `normal`, optionally filling the cut and clearing one side. Changes the document. */
  "mesh.bisect": { /** Delete what lies behind the plane */ clearInner?: boolean; /** Delete what lies in front of the plane */ clearOuter?: boolean; /** Close the cut with a face (with clearing) */ fill?: boolean; /** The plane's normal, in the object's own axes ([0, 0, 1]) [x, y, z] */ normal?: Array<number>; /** A point on the cutting plane, in the object's own axes (the selection's centre) [x, y, z] */ point?: Array<number> }
  /** Separate Selection. Moves the selected elements of the edited mesh into a new object named `name`. Changes the document. */
  "mesh.separate": { /** The new object's name */ name?: string }
  /** Symmetrize. Makes the edited mesh symmetric across `axis`, copying one side to the other. Changes the document. */
  "mesh.symmetrize": { /** The axis whose plane the mesh is mirrored across (x) */ axis?: "x" | "y" | "z"; /** Which side replaces the other (positive) */ direction?: "positive" | "negative" }
  /** Spin. Spins the selected elements `angle` degrees about `axis` through `center` in `steps`, making a lathe. Changes the document. */
  "mesh.spin": { /** Degrees to sweep (90); 360 closes the sweep */ angle?: number; /** The axis to sweep round ([0, 0, 1]) [x, y, z] */ axis?: Array<number>; /** A point on the axis, in the object's own axes (the origin) [x, y, z] */ center?: Array<number>; /** Steps (12) */ steps?: number }
  /** Bevel Vertices. Bevels the selected vertices with `width`, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.bevelVertices": { /** How far along each edge the cut is, metres (0.1) */ width?: number }
  /** Rotate Elements. Rotates the selected elements by `angle` degrees about `axis` through `pivot`, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.rotate": { /** Degrees, counter-clockwise looking down the axis */ angle: number; /** The object's axis to turn round */ axis: "x" | "y" | "z"; /** The point to turn about; the selection's centre when left out [x, y, z] */ pivot?: Array<number> }
  /** Proportional Editing. Turns proportional editing on or off and sets its falloff and radius; answers the setting. */
  "mesh.proportional": { /** Only vertices joined to the selection by edges follow, by their distance along the edges */ connected?: boolean; /** How the pull fades with distance */ falloff?: "smooth" | "sphere" | "root" | "linear" | "sharp" | "constant"; /** On or off; toggles when left out */ on?: boolean; /** How far, in metres, unselected vertices follow (1) */ radius?: number }
  /** Smart UV Project. Unwraps `objects` (names or ids; the selection without it) with smart UV project (by angle limit, with margin). Changes the document. */
  "uv.smartProject": { /** Faces whose normals differ by more than this many degrees go to separate islands (66) */ angleLimit?: number; /** Space between islands, as a fraction of the texture (0.02) */ margin?: number; /** The mesh objects, in object mode; the selection when left out */ objects?: Json }
  /** Cube Projection. Projects UVs of `objects` (names or ids; the selection without it) from a cube of `size`. Changes the document. */
  "uv.cubeProject": { /** The mesh objects, in object mode; the selection when left out */ objects?: Json; /** Metres one repeat of the texture covers (2) */ size?: number }
  /** Cylinder Projection. Projects UVs of `objects` (names or ids; the selection without it) from a cylinder. Changes the document. */
  "uv.cylinderProject": { /** The mesh objects, in object mode; the selection when left out */ objects?: Json }
  /** Sphere Projection. Projects UVs of `objects` (names or ids; the selection without it) from a sphere. Changes the document. */
  "uv.sphereProject": { /** The mesh objects, in object mode; the selection when left out */ objects?: Json }
  /** Planar Projection. Projects UVs of `objects` (names or ids; the selection without it) flat along `axis`. Changes the document. */
  "uv.planarProject": { /** The local axis to project along (z) */ axis?: "x" | "y" | "z"; /** The mesh objects, in object mode; the selection when left out */ objects?: Json; /** Metres one repeat of the texture covers (2) */ size?: number }
  /** Reset. Resets the UVs of `objects` (names or ids; the selection without it) so each face fills the whole UV square. Changes the document. */
  "uv.reset": { /** The mesh objects, in object mode; the selection when left out */ objects?: Json }
  /** Clear UVs. Removes the UV maps of `objects` (names or ids; the selection without it). Changes the document. */
  "uv.clear": { /** The mesh objects, in object mode; the selection when left out */ objects?: Json }
  /** Set Material Image. Sets an image (workspace `path` or base64) as a texture slot (base color, normal, roughness, ...) of `material`, or clears it. Changes the document. */
  "material.setTexture": { /** The image's bytes, instead of a path */ base64?: string; /** Take the image out of the slot */ clear?: boolean; /** The material's id or name */ material: Json; /** The image's name, with base64 bytes */ name?: string; /** A .png or .jpg file, relative to this scene's folder */ path?: Json; /** The image slot (baseColor) */ slot?: "baseColor" | "metallicRoughness" | "normal" }
  /** Set Displace Image. Sets the image a displace modifier reads (workspace path or base64), or clears it. Changes the document. */
  "modifier.setImage": { /** The image's bytes, instead of a path */ base64?: string; /** Take the image off the modifier */ clear?: boolean; /** The image's name, with base64 bytes */ imageName?: string; /** The Displace modifier's position in the stack, from 0 */ index?: number; /** The Displace modifier's name (instead of index) */ name?: string; /** The object; the active one when left out */ object?: Json; /** A .png or .jpg file, relative to this scene's folder */ path?: Json }
  /** World Image. Sets an environment image (workspace path or base64) as the world background, with rotation and strength, or clears it. Changes the document. */
  "world.setImage": { /** The image's bytes, instead of a path */ base64?: string; /** Remove the image: the world colour shows and lights again */ clear?: boolean; /** The image's name, with base64 */ name?: string; /** An equirectangular .hdr, .png, or .jpg, relative to this scene's folder */ path?: Json; /** Degrees the image is turned about the up axis */ rotation?: number; /** How strongly the world lights the scene */ strength?: number }
  /** Path Trace. Starts a path-traced render (bounces, samples, denoise) in steps; answers its progress. Continue with `render.trace.step`. */
  "render.trace.start": { /** The longest light path, in bounces (4) */ bounces?: number; /** Trace nothing here: merge the sums of workers' shards (false) */ collect?: boolean; /** Smooth the remaining noise away (false) */ denoise?: boolean; /** The frame to render; the current frame when left out */ frame?: number; /** Samples per pixel, 1 to 4096 (64) */ samples?: number; /** Changes the noise pattern (0) */ seed?: number; /** How often light may scatter in a volume before the path ends (0: each point in a volume is lit directly only) */ volumeBounces?: number; /** Render to the end and answer the image at once (false) */ wait?: boolean }
  /** Continue Path Trace. Continues the path-traced render for `budgetMs` and answers its progress, with the picture so far when `preview`. */
  "render.trace.step": { /** About how long to render, in milliseconds (50) */ budgetMs?: number; /** Answer the picture so far as a PNG (false) */ preview?: boolean }
  /** Path Traced Image. Answers the path-traced picture so far as a base64 PNG. */
  "render.trace.image": Record<string, never>
  /** Cancel Path Trace. Cancels the path-traced render under way. */
  "render.trace.cancel": Record<string, never>
  /** Mark Seam. Marks the selected edges as UV seams, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.markSeam": Record<string, never>
  /** Clear Seam. Clears UV seams from the selected edges, in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.clearSeam": Record<string, never>
  /** Unwrap. Unwraps the edited mesh's selected faces along their seams (angle-based, conformal, or minimumStretch SLIM) with `margin`; minimum stretch uses 1 to 100 `iterations` and keeps pins fixed. Changes the document. */
  "uv.unwrap": { /** Minimum stretch iterations, 1 to 100 (30) */ iterations?: number; /** Space between islands, as a fraction of the square (0.02) */ margin?: number; /** How islands are flattened (angleBased) */ method?: "angleBased" | "conformal" | "minimumStretch" }
  /** Live Unwrap. Sets local UV live unwrap preferences (`on`, `method`, `iterations`) without changing the scene. Pinned UV transforms relax their islands in one undo step. */
  "uv.liveUnwrap": { /** Minimum stretch iterations, 1 to 100 (30) */ iterations?: number; /** Live relaxation method */ method?: "angleBased" | "conformal" | "minimumStretch"; /** Enable live relaxation while pinned UVs move */ on?: boolean }
  /** Preview UV Move. Answers a UV layout after a proposed `offset`, including live relaxation (`source` rejects a stale drag), without changing the scene, selection, history, or preferences. */
  "uv.preview": { /** UV drag offset [u, v] */ offset: Array<number>; /** Optional UV layout source token; reject a stale drag without changing the scene */ source?: string }
  /** Stitch. Stitches the selected UV edges to their neighbours in the UV editor. Changes the document. */
  "uv.stitch": Record<string, never>
  /** Pin. Pins the selected UVs so unwrapping keeps them in place. Changes the document. */
  "uv.pin": Record<string, never>
  /** Unpin. Unpins the selected UVs. Changes the document. */
  "uv.unpin": Record<string, never>
  /** Move UVs. Moves the selected UVs by `offset`. Changes the document. */
  "uv.translate": { /** How far in UV units [u, v] */ offset: Array<number>; /** Optional UV layout source token; reject a stale drag without changing the scene */ source?: string }
  /** Rotate UVs. Rotates the selected UVs by `angle` degrees about `pivot`. Changes the document. */
  "uv.rotate": { /** Degrees, counter-clockwise */ angle: number; /** The point in UV space to turn or scale about [u, v]; the moved coordinates' centre when left out */ pivot?: Array<number>; /** Optional UV layout source token; reject a stale drag without changing the scene */ source?: string }
  /** Scale UVs. Scales the selected UVs by `factor` about `pivot`. Changes the document. */
  "uv.scale": { /** A number, or [u, v] */ factor: Json; /** The point in UV space to turn or scale about [u, v]; the moved coordinates' centre when left out */ pivot?: Array<number>; /** Optional UV layout source token; reject a stale drag without changing the scene */ source?: string }
  /** UV Layout. Answers the edited mesh's UV layout (faces and their UV coordinates), all faces or the selected ones. */
  "uv.layout": { /** Every face, not only the selected ones (false) */ all?: boolean }
  /** Knife. Cuts the edited mesh along `points` (screen-space path), through the whole mesh with `through`. Changes the document. */
  "mesh.knife": { /** The cut line: view pixels [x, y], or points in the world [x, y, z], at least two */ points?: Array<Json>; /** Cut faces turned away from the view too (false) */ through?: boolean }
  /** Edge Slide. Slides the selected edges along their neighbours by `factor` (-1 to 1), in edit mode on the edited mesh's selected elements (`mode.set {mode: "edit"}` and `mesh.select` first). Changes the document. */
  "mesh.edgeSlide": { /** How far towards the next edge loop, -1 to 1 */ factor: number }
  /** Insert Keyframe. Inserts keyframes for `properties` (location, rotation, scale, ...) or a keying set of `objects` (names or ids; the selection without it) at `frame`. Changes the document. */
  "anim.insertKey": { /** The frame; the current frame when left out */ frame?: number; /** insertKey: key what this keying set names instead (the active one is used when no properties are given) */ keyingSet?: string; /** The objects; the selection when left out */ objects?: Json; /** What to key: location, rotation, scale, hidden; power and color of a light; lens of a camera; baseColor of the object's material (location, rotation, and scale when left out) */ properties?: Array<"location" | "rotation" | "scale" | "hidden" | "power" | "color" | "lens" | "baseColor"> }
  /** Delete Keyframe. Deletes the keyframes for `properties` of `objects` (names or ids; the selection without it) at `frame`. Changes the document. */
  "anim.deleteKey": { /** The frame; the current frame when left out */ frame?: number; /** insertKey: key what this keying set names instead (the active one is used when no properties are given) */ keyingSet?: string; /** The objects; the selection when left out */ objects?: Json; /** What to key: location, rotation, scale, hidden; power and color of a light; lens of a camera; baseColor of the object's material (location, rotation, and scale when left out) */ properties?: Array<"location" | "rotation" | "scale" | "hidden" | "power" | "color" | "lens" | "baseColor"> }
  /** Clear Keyframes. Clears every keyframe (or those of `properties`) of `objects` (names or ids; the selection without it). Changes the document. */
  "anim.clear": { /** The objects; the selection when left out */ objects?: Json; /** Only these properties (every animated one when left out) */ properties?: Array<string> }
  /** Interpolation. Sets the interpolation (constant, linear, bezier, ...) of keyframes of `objects` (names or ids; the selection without it) at `frame`. Changes the document. */
  "anim.setInterpolation": { /** Only the keys on this frame (every key when left out) */ frame?: number; /** How the curve runs from a key to the next */ interpolation: "bezier" | "linear" | "constant"; /** insertKey: key what this keying set names instead (the active one is used when no properties are given) */ keyingSet?: string; /** The objects; the selection when left out */ objects?: Json; /** What to key: location, rotation, scale, hidden; power and color of a light; lens of a camera; baseColor of the object's material (location, rotation, and scale when left out) */ properties?: Array<"location" | "rotation" | "scale" | "hidden" | "power" | "color" | "lens" | "baseColor"> }
  /** Go to Frame. Goes to frame `frame` and answers it; the scene shows its animated state there. */
  "frame.set": { /** The frame */ frame: number }
  /** Next Frame. Goes to the next frame and answers it. */
  "frame.next": Record<string, never>
  /** Previous Frame. Goes to the previous frame (wrapping to the end) and answers it. */
  "frame.previous": Record<string, never>
  /** Jump to Start. Goes to the first frame of the range and answers it. */
  "frame.start": Record<string, never>
  /** Jump to End. Goes to the last frame of the range and answers it. */
  "frame.end": Record<string, never>
  /** Jump to Next Keyframe. Goes to the next keyframe of the selected objects and answers its frame. */
  "anim.nextKey": Record<string, never>
  /** Jump to Previous Keyframe. Goes to the previous keyframe of the selected objects and answers its frame. */
  "anim.previousKey": Record<string, never>
  /** Frame Range. Sets the animation's start and end frames and frames per second. Changes the document. */
  "frame.range": { /** The last frame */ end?: number; /** Frames per second */ fps?: number; /** The first frame */ start?: number }
  /** Render Animation. Renders frames `start` to `end` (every `step`) and answers them as pictures. Does not change the scene. */
  "render.animation": { /** The last frame (the range's end when left out) */ end?: number; /** Samples per pixel side, 1 to 4 (1) */ samples?: number; /** The first frame (the range's start when left out) */ start?: number; /** Render every nth frame (1) */ step?: number }
  /** Add Driver. Adds a driver to a property (of an object, bone or shape key) computed from `expression` and its variables. Changes the document. */
  "driver.add": { /** The bone of a bone property */ bone?: string; /** scripted: Python-style arithmetic over the variables and `frame` (+ - * / // % **, comparisons, and, or, not, a if c else b, sin, cos, min, max, clamp, lerp, radians, ...); angles in radians */ expression?: string; /** The component (x 0, y 1, z 2, alpha 3); every component when left out */ index?: number; /** How the variables combine (scripted evaluates `expression`) */ kind?: "average" | "sum" | "min" | "max" | "scripted"; /** The object (or the armature of `bone`, the mesh of `shapeKey`, the owner of the material); the active object when left out */ object?: Json; /** The driven property (bone ones name `bone`, shapeKey names `shapeKey`, baseColor is the object's material's) */ property: "location" | "rotation" | "scale" | "hidden" | "power" | "color" | "lens" | "baseColor" | "boneLocation" | "boneRotation" | "boneScale" | "shapeKey"; /** The shape key of a shapeKey property */ shapeKey?: string; /** The variables, replacing any: { name, type: singleProperty, object, property, index, bone?, shapeKey? } | { name, type: transform, object, bone?, channel: locationX..scaleZ or scaleAverage, space: world, transform, or local } | { name, type: distance or rotationDifference, a, aBone?, b, bBone? } */ variables?: Array<{ [key: string]: Json }> }
  /** Change Driver. Changes a driver's expression or variables. Changes the document. */
  "driver.set": { /** The bone of a bone property */ bone?: string; /** scripted: Python-style arithmetic over the variables and `frame` (+ - * / // % **, comparisons, and, or, not, a if c else b, sin, cos, min, max, clamp, lerp, radians, ...); angles in radians */ expression?: string; /** The component (x 0, y 1, z 2, alpha 3); every component when left out */ index?: number; /** How the variables combine (scripted evaluates `expression`) */ kind?: "average" | "sum" | "min" | "max" | "scripted"; /** The object (or the armature of `bone`, the mesh of `shapeKey`, the owner of the material); the active object when left out */ object?: Json; /** The driven property (bone ones name `bone`, shapeKey names `shapeKey`, baseColor is the object's material's) */ property: "location" | "rotation" | "scale" | "hidden" | "power" | "color" | "lens" | "baseColor" | "boneLocation" | "boneRotation" | "boneScale" | "shapeKey"; /** The shape key of a shapeKey property */ shapeKey?: string; /** The variables, replacing any: { name, type: singleProperty, object, property, index, bone?, shapeKey? } | { name, type: transform, object, bone?, channel: locationX..scaleZ or scaleAverage, space: world, transform, or local } | { name, type: distance or rotationDifference, a, aBone?, b, bBone? } */ variables?: Array<{ [key: string]: Json }> }
  /** Remove Driver. Removes the driver from a property. Changes the document. */
  "driver.remove": { /** The bone of a bone property */ bone?: string; /** The component (x 0, y 1, z 2, alpha 3); every component when left out */ index?: number; /** The object (or the armature of `bone`, the mesh of `shapeKey`, the owner of the material); the active object when left out */ object?: Json; /** The driven property (bone ones name `bone`, shapeKey names `shapeKey`, baseColor is the object's material's) */ property: "location" | "rotation" | "scale" | "hidden" | "power" | "color" | "lens" | "baseColor" | "boneLocation" | "boneRotation" | "boneScale" | "shapeKey"; /** The shape key of a shapeKey property */ shapeKey?: string }
  /** Add Keying Set. Adds a keying set named `name` to the scene. Changes the document. */
  "keyingSet.new": { /** Its name (Keying Set) */ name?: string }
  /** Remove Keying Set. Removes keying set `name`. Changes the document. */
  "keyingSet.remove": { /** The keying set; the active one when left out */ name?: string }
  /** Add to Keying Set. Adds properties of objects or bones to keying set `name`. Changes the document. */
  "keyingSet.addPaths": { /** Bones of the (one) armature named; its location, rotation, and scale */ bones?: Array<string>; /** The keying set; the active one of the scene's own when left out */ name?: string; /** The objects; the selection when left out */ objects?: Json; /** The properties (location, rotation, and scale when left out; bone ones with `bones`) */ properties?: Array<"location" | "rotation" | "scale" | "hidden" | "power" | "color" | "lens" | "baseColor" | "boneLocation" | "boneRotation" | "boneScale" | "shapeKey"> }
  /** Remove from Keying Set. Removes path `index` from keying set `name`. Changes the document. */
  "keyingSet.removePath": { /** The path's position, from 0 */ index: number; /** The keying set; the active one when left out */ name?: string }
  /** Active Keying Set. Makes keying set `name` the one `anim.insertKey` uses by default. Changes the document. */
  "keyingSet.setActive": { /** location, rotation, scale, locRot, locScale, locRotScale, rotScale, available, wholeCharacter, or the name of one of the scene's own; null for none */ name?: string }
  /** New Action. Creates an action named `name` and assigns it to `object`. Changes the document. */
  "action.new": { /** Its name (Action) */ name?: string; /** An object whose keys (an armature's bones' too) the action takes; an empty action when left out */ object?: Json }
  /** Assign Action. Assigns action `action` to `objects` (names or ids; the selection without it). Changes the document. */
  "action.assign": { /** The action; its keys replace each object's (bone keys go to an armature's bones of the same names) */ action: string; /** The objects; the selection when left out */ objects?: Json }
  /** Remove Action. Deletes action `name` from the file; objects using it lose their animation. Changes the document. */
  "action.remove": { /** The action */ name: string }
  /** Rename Action. Renames action `name` to `to`. Changes the document. */
  "action.rename": { /** The action */ name: string; /** The new name */ to: string }
  /** Push Down. Pushes `object`'s active action down into a new NLA strip. Changes the document. */
  "nla.pushDown": { /** The new action's name (<object>Action) */ name?: string; /** The object; the active one when left out */ object?: Json }
  /** Add NLA Track. Adds an NLA track to `object` at `index`. Changes the document. */
  "nla.addTrack": { /** Where, from 0 at the bottom; on top when left out */ index?: number; /** Its name (NlaTrack) */ name?: string; /** The object; the active one when left out */ object?: Json }
  /** Remove NLA Track. Removes NLA track `track` from `object`. Changes the document. */
  "nla.removeTrack": { /** The object; the active one when left out */ object?: Json; /** The track, from 0 at the bottom */ track: number }
  /** NLA Track Settings. Changes NLA track `track`: name, mute, solo, position. Changes the document. */
  "nla.setTrack": { /** Moves it to this position, from 0 at the bottom */ moveTo?: number; /** Does nothing */ muted?: boolean; /** Its name */ name?: string; /** The object; the active one when left out */ object?: Json; /** The only track evaluated (one at a time) */ solo?: boolean; /** The track, from 0 at the bottom */ track: number }
  /** Add Action Strip. Adds a strip of action `action` to NLA track `track` of `object` at frame `start`. Changes the document. */
  "nla.addStrip": { /** The action it plays */ action: string; /** The object; the active one when left out */ object?: Json; /** The frame it starts at; the current frame when left out */ start?: number; /** The track; the top one when it has room, else a new one */ track?: number }
  /** Action Strip Settings. Changes NLA strip `strip` of track `track`: action range, blending, repeats, scale; a meta uses `start` and `end` to move or stretch its children. Transitions follow their neighbors. Changes the document. */
  "nla.setStrip": { /** The last action frame it plays */ actionEnd?: number; /** The first action frame it plays */ actionStart?: number; /** Blends in and out over the strips of the tracks below and above it that overlap it (switching it off clears the blends) */ autoBlend?: boolean; /** How it mixes onto the tracks below */ blend?: "replace" | "combine" | "add" | "subtract" | "multiply"; /** Frames its influence rises over at its start */ blendIn?: number; /** Frames its influence falls over at its end */ blendOut?: number; /** Meta strips: move or stretch the children together to this end frame */ end?: number; /** Outside its frames: hold (both ways; only the first strip of a track holds backwards), holdForward, or nothing */ extrapolation?: "hold" | "holdForward" | "nothing"; /** A fixed influence from 0 to 1 in place of the blends; null for the blends */ influence?: number; /** Does nothing */ muted?: boolean; /** The strip's name */ name?: string; /** The object; the active one when left out */ object?: Json; /** How many times it plays (0.01 or more) */ repeat?: number; /** Plays backwards */ reversed?: boolean; /** How many times slower it plays (0.0001 or more) */ scale?: number; /** The scene frame it starts at */ start?: number; /** The strip on the track, from 0 (frame order) */ strip: number; /** Moves it to this track */ toTrack?: number; /** The track, from 0 at the bottom */ track: number }
  /** Add Transition Strip. Adds a transition between strip `strip` and its next neighbor on track `track`, blending their endpoint evaluations across the gap. Changes the document. */
  "nla.addTransition": { /** The object; the active one when left out */ object?: Json; /** The strip on the track, from 0 (frame order) */ strip: number; /** The track, from 0 at the bottom */ track: number }
  /** Make Meta Strip. Groups the contiguous strips `first` through `last` on `track` into one meta strip; its start and end move or stretch the children together. Changes the document. */
  "nla.makeMeta": { /** First strip in the contiguous group */ first: number; /** Last strip in the contiguous group, inclusive */ last: number; /** The object; the active one when left out */ object?: Json; /** The track, from 0 at the bottom */ track: number }
  /** Dissolve Meta Strip. Ungroups meta strip `strip` on `track`, preserving the children's current timing and blending. Changes the document. */
  "nla.dissolveMeta": { /** The object; the active one when left out */ object?: Json; /** The strip on the track, from 0 (frame order) */ strip: number; /** The track, from 0 at the bottom */ track: number }
  /** Remove Action Strip. Removes NLA strip `strip` from track `track` of `object`. Changes the document. */
  "nla.removeStrip": { /** The object; the active one when left out */ object?: Json; /** The strip on the track, from 0 (frame order) */ strip: number; /** The track, from 0 at the bottom */ track: number }
  /** Active Action Blending. Sets how `object`'s active action blends over the NLA (blend mode, extrapolation, influence). Changes the document. */
  "nla.setAction": { /** How the object's own keys mix onto the tracks */ blend?: "replace" | "combine" | "add" | "subtract" | "multiply"; /** Outside their keyed frames */ extrapolation?: "hold" | "holdForward" | "nothing"; /** Their influence, 0 to 1 */ influence?: number; /** The object; the active one when left out */ object?: Json }
  /** Start Tweaking Strip Action. Starts tweaking the action of NLA strip `strip` so keyframe edits go into it. Changes the document. */
  "nla.tweak": { /** The object; the active one when left out */ object?: Json; /** The strip on the track, from 0 (frame order) */ strip: number; /** The track, from 0 at the bottom */ track: number; /** Evaluates the tracks above too (false: the lower stack only) */ upperStack?: boolean }
  /** Stop Tweaking Strip Action. Stops tweaking the NLA strip's action. Changes the document. */
  "nla.tweakExit": { /** The object; the active one when left out */ object?: Json }
  /** Add F-Curve Modifier. Adds an F-curve modifier (cycles, noise, generator, ...) to an animated property's curve. Changes the document. */
  "graph.addModifier": { /** generator, function: adds to the curve instead of replacing it */ additive?: boolean; /** cycles: after the last key */ after?: "none" | "repeat" | "repeatOffset" | "mirror"; /** cycles: cycles after (0 forever) */ afterCount?: number; /** function */ amplitude?: number; /** cycles: before the first key */ before?: "none" | "repeat" | "repeatOffset" | "mirror"; /** cycles: cycles before (0 forever) */ beforeCount?: number; /** noise: how it mixes in */ blend?: "replace" | "add" | "subtract" | "multiply"; /** generator: the coefficients */ coefficients?: Array<number>; /** noise: octaves beyond the first (0 to 32) */ depth?: number; /** stepped: steps only up to this frame; null for always */ end?: number; /** function: the function of amplitude ? f(phaseMultiplier ? frame + phaseOffset) + valueOffset */ function?: "sin" | "cos" | "tan" | "sqrt" | "ln" | "sinc"; /** The component, from 0 (0) */ index?: number; /** Scales its effect, 0 to 1; null for full */ influence?: number; /** noise: frequency step between octaves */ lacunarity?: number; /** envelope: the high end, above the reference */ max?: number; /** limits: maximum evaluated frame; null disables */ maxX?: Json; /** limits: maximum curve value; null disables */ maxY?: Json; /** envelope: the low end, below the reference */ min?: number; /** limits: minimum evaluated frame; null disables */ minX?: Json; /** limits: minimum curve value; null disables */ minY?: Json; /** generator: expanded (c0 + c1?x + ...) or factorized ((c0?x + c1)(c2?x + c3)...) */ mode?: "expanded" | "factorized"; /** Does nothing (values of rotation channels are radians) */ muted?: boolean; /** noise, stepped: frame offset */ offset?: number; /** The bone or shape key, for their properties */ path?: string; /** noise */ phase?: number; /** function */ phaseMultiplier?: number; /** function */ phaseOffset?: number; /** envelope: control points { frame, min, max } in frame order */ points?: Array<{ [key: string]: Json }>; /** The channel's property (location, boneRotation, shapeKey, ...) */ property: string; /** Limits it to { start, end, blendIn, blendOut } frames; null for everywhere */ range?: { [key: string]: Json }; /** envelope: the reference value */ reference?: number; /** noise: amplitude step between octaves */ roughness?: number; /** noise: frames per noise feature */ scale?: number; /** stepped: steps only from this frame; null for always */ start?: number; /** stepped: frames each step holds */ step?: number; /** noise */ strength?: number; /** The channel's object (or material) id */ target: number; /** The modifier */ type: "generator" | "function" | "envelope" | "cycles" | "noise" | "stepped" | "limits"; /** function */ valueOffset?: number }
  /** F-Curve Modifier Settings. Changes an F-curve modifier's settings. Changes the document. */
  "graph.setModifier": { /** generator, function: adds to the curve instead of replacing it */ additive?: boolean; /** cycles: after the last key */ after?: "none" | "repeat" | "repeatOffset" | "mirror"; /** cycles: cycles after (0 forever) */ afterCount?: number; /** function */ amplitude?: number; /** cycles: before the first key */ before?: "none" | "repeat" | "repeatOffset" | "mirror"; /** cycles: cycles before (0 forever) */ beforeCount?: number; /** noise: how it mixes in */ blend?: "replace" | "add" | "subtract" | "multiply"; /** generator: the coefficients */ coefficients?: Array<number>; /** noise: octaves beyond the first (0 to 32) */ depth?: number; /** stepped: steps only up to this frame; null for always */ end?: number; /** function: the function of amplitude ? f(phaseMultiplier ? frame + phaseOffset) + valueOffset */ function?: "sin" | "cos" | "tan" | "sqrt" | "ln" | "sinc"; /** The component, from 0 (0) */ index?: number; /** Scales its effect, 0 to 1; null for full */ influence?: number; /** noise: frequency step between octaves */ lacunarity?: number; /** envelope: the high end, above the reference */ max?: number; /** limits: maximum evaluated frame; null disables */ maxX?: Json; /** limits: maximum curve value; null disables */ maxY?: Json; /** envelope: the low end, below the reference */ min?: number; /** limits: minimum evaluated frame; null disables */ minX?: Json; /** limits: minimum curve value; null disables */ minY?: Json; /** generator: expanded (c0 + c1?x + ...) or factorized ((c0?x + c1)(c2?x + c3)...) */ mode?: "expanded" | "factorized"; /** The modifier's place in the stack, from 0 */ modifier: number; /** Moves it to this place in the stack */ moveTo?: number; /** Does nothing (values of rotation channels are radians) */ muted?: boolean; /** noise, stepped: frame offset */ offset?: number; /** The bone or shape key, for their properties */ path?: string; /** noise */ phase?: number; /** function */ phaseMultiplier?: number; /** function */ phaseOffset?: number; /** envelope: control points { frame, min, max } in frame order */ points?: Array<{ [key: string]: Json }>; /** The channel's property (location, boneRotation, shapeKey, ...) */ property: string; /** Limits it to { start, end, blendIn, blendOut } frames; null for everywhere */ range?: { [key: string]: Json }; /** envelope: the reference value */ reference?: number; /** noise: amplitude step between octaves */ roughness?: number; /** noise: frames per noise feature */ scale?: number; /** stepped: steps only from this frame; null for always */ start?: number; /** stepped: frames each step holds */ step?: number; /** noise */ strength?: number; /** The channel's object (or material) id */ target: number; /** function */ valueOffset?: number }
  /** Remove F-Curve Modifier. Removes an F-curve modifier from a curve. Changes the document. */
  "graph.removeModifier": { /** The component, from 0 (0) */ index?: number; /** The modifier's place in the stack, from 0 */ modifier: number; /** The bone or shape key, for their properties */ path?: string; /** The channel's property (location, boneRotation, shapeKey, ...) */ property: string; /** The channel's object (or material) id */ target: number }
  /** Armature. Adds an armature with one bone at `location` and answers its name and object id. Changes the document. */
  "add.armature": { /** Where to put it, in metres [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string }
  /** Toggle Edit Mode. Toggles the active armature between object mode and bone edit mode. */
  "mode.armature": Record<string, never>
  /** Pose Mode. Turns pose mode on or off for armature `object`. */
  "mode.pose": { /** The armature; the active one when left out */ object?: Json; /** Pose mode on or off; toggles when left out */ on?: boolean }
  /** Add Bone. Adds a bone with head and tail to the armature in edit mode, optionally parented and connected. Changes the document. */
  "bone.add": { /** The head sits on the parent's tail */ connected?: boolean; /** Where it starts, in the armature's space (the origin) [x, y, z] */ head?: Array<number>; /** The bone's name (Bone) */ name?: string; /** The parent bone */ parent?: string; /** Where it ends (a metre above the head) [x, y, z] */ tail?: Array<number> }
  /** Extrude Bone. Extrudes a new bone from the selected bone's tail by `length` or to `tail`. Changes the document. */
  "bone.extrude": { /** Its length along the bone it grows from (the same length) */ length?: number; /** Where the new bone ends, in the armature's space [x, y, z] */ tail?: Array<number> }
  /** Bone Settings. Changes bone `bone`: name, head, tail, roll, parent, connection, deform. Changes the document. */
  "bone.set": { /** The bone; the active one when left out */ bone?: string; /** The head sits on the parent's tail */ connected?: boolean; /** The bone deforms meshes */ deform?: boolean; /** Envelope: how far past the radii it fades out, metres (0.25) */ envelopeDistance?: number; /** Multiply the bone's vertex group weights by its envelope */ envelopeMultiply?: boolean; /** Envelope: its strength where full (1) */ envelopeWeight?: number; /** Where it starts, armature space [x, y, z] */ head?: Array<number>; /** Envelope: the radius at the head, metres (0.1) */ headRadius?: number; /** A new name */ name?: string; /** The armature; the active one when left out */ object?: Json; /** The parent bone; an empty string clears it */ parent?: string; /** Turn about its own axis, degrees */ roll?: number; /** Custom shape: the object whose mesh draws the bone; null for the octahedron */ shape?: Json; /** Custom shape: scaled by the bone's length too (true) */ shapeBoneSize?: boolean; /** Custom shape: its turn in the bone's axes, degrees [x, y, z] */ shapeRotation?: Array<number>; /** Custom shape: its scale [x, y, z] */ shapeScale?: Array<number>; /** Custom shape: its offset in the bone's axes, metres [x, y, z] */ shapeTranslation?: Array<number>; /** Custom shape: drawn as its edges only */ shapeWire?: boolean; /** Where it ends, armature space [x, y, z] */ tail?: Array<number>; /** Envelope: the radius at the tail, metres (0.05) */ tailRadius?: number }
  /** Select Bones. Selects bones by name in edit or pose mode, adding with `extend` or removing with `deselect`. */
  "bone.select": { /** The bones to select */ bones: Json; /** Take them out of the selection */ deselect?: boolean; /** Add to the selection */ extend?: boolean }
  /** Pose Bones. Sets location, rotation and/or scale of pose bones `bones`. Changes the document. */
  "pose.set": { /** The bones; the selected ones when left out */ bones?: Json; /** Location in the bone's rest space, metres [x, y, z] */ location?: Array<number>; /** Rotation in degrees, XYZ Euler, in the bone's rest space [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number> }
  /** Clear Pose. Clears the pose of `bones` (or all) back to the rest pose. Changes the document. */
  "pose.clear": { /** Every bone */ all?: boolean; /** The bones; the selected ones when left out */ bones?: Json }
  /** Insert Keyframe. Inserts keyframes for pose bones `bones` at `frame`. Changes the document. */
  "pose.insertKey": { /** The bones; the selected ones when left out */ bones?: Json; /** The frame; the current frame when left out */ frame?: number; /** Key what this keying set names instead (the active one is used when no properties are given) */ keyingSet?: string; /** What to key (all three when left out) */ properties?: Array<"location" | "rotation" | "scale"> }
  /** Delete Keyframe. Deletes the keyframes of pose bones `bones` at `frame`. Changes the document. */
  "pose.deleteKey": { /** The bones; the selected ones when left out */ bones?: Json; /** The frame; the current frame when left out */ frame?: number }
  /** Parent to Armature. Parents `objects` (names or ids; the selection without it) to `armature` with automatic, envelope or empty weights. Changes the document. */
  "object.parentArmature": { /** The armature; the active object when left out */ armature?: Json; /** The meshes; the selected ones without the active armature when left out */ objects?: Json; /** How the vertex groups are made */ weights?: "automatic" | "empty" | "none" }
  /** Add Vertex Group. Adds a vertex group named `name` to `object`. Changes the document. */
  "vertexGroup.add": { /** The group's name (Group) */ name?: string; /** The mesh object; the edited or active one when left out */ object?: Json }
  /** Remove Vertex Group. Removes vertex group `name` from `object`. Changes the document. */
  "vertexGroup.remove": { /** The group */ name: string; /** The mesh object; the edited or active one when left out */ object?: Json }
  /** Assign to Group. Assigns vertices (by index, else the selected ones) to vertex group `name` with `weight`. Changes the document. */
  "vertexGroup.assign": { /** The group (made when missing) */ name: string; /** The mesh object; the edited or active one when left out */ object?: Json; /** The vertices; the edit-mode selection when left out */ vertices?: Array<number>; /** 0 to 1 (1) */ weight?: number }
  /** Remove from Group. Removes vertices (by index, else the selected ones) from vertex group `name`. Changes the document. */
  "vertexGroup.unassign": { /** The group */ name: string; /** The mesh object; the edited or active one when left out */ object?: Json; /** The vertices; the edit-mode selection when left out */ vertices?: Array<number> }
  /** Select Group. Selects the vertices of vertex group `name` in edit mode. */
  "vertexGroup.select": { /** The group */ name: string }
  /** Add Shape Key. Adds a shape key named `name` to `object`, from the basis or `from`, optionally with vertex `offsets`. Changes the document. */
  "shapeKey.add": { /** A mesh with the same vertex count whose shape the key takes */ from?: Json; /** The key's name (Key 1, Key 2, ...) */ name?: string; /** The mesh object; the edited or active one when left out */ object?: Json; /** An offset [x, y, z] per vertex, in the object's own axes */ offsets?: Array<Json> }
  /** Remove Shape Key. Removes shape key `name` from `object`. Changes the document. */
  "shapeKey.remove": { /** The key */ name: string; /** The mesh object; the edited or active one when left out */ object?: Json }
  /** Shape Key Settings. Sets shape key `name`'s value (0 to 1) or renames it. Changes the document. */
  "shapeKey.set": { /** The key */ name: string; /** The mesh object; the edited or active one when left out */ object?: Json; /** A new name */ rename?: string; /** How much of the shape, usually 0 to 1 */ value?: number }
  /** Move in Shape Key. Moves vertices of shape key `name` by `offset`. Changes the document. */
  "shapeKey.offset": { /** The key */ name: string; /** The mesh object; the edited or active one when left out */ object?: Json; /** How far the vertices move in this shape, object axes [x, y, z] */ offset: Array<number>; /** The vertices; the edit-mode selection when left out */ vertices?: Array<number> }
  /** Key Shape Value. Inserts a keyframe for shape key `name`'s value at `frame`. Changes the document. */
  "shapeKey.insertKey": { /** The frame; the current frame when left out */ frame?: number; /** The key */ name: string; /** The mesh object; the edited or active one when left out */ object?: Json }
  /** Move Keyframe. Moves a keyframe of an animated property from `frame` to `toFrame`. Changes the document. */
  "graph.moveKey": { /** The key's frame */ frame: number; /** The component, from 0 (0) */ index?: number; /** The bone or shape key, for their properties */ path?: string; /** The channel's property (location, boneRotation, shapeKey, ...) */ property: string; /** The channel's object (or material) id */ target: number; /** The key's new frame */ toFrame?: number; /** The key's new value (degrees for rotations) */ value?: number }
  /** Delete Keyframe. Deletes the keyframe at `frame` of an animated property. Changes the document. */
  "graph.deleteKey": { /** The key's frame */ frame: number; /** The component, from 0 (0) */ index?: number; /** The bone or shape key, for their properties */ path?: string; /** The channel's property (location, boneRotation, shapeKey, ...) */ property: string; /** The channel's object (or material) id */ target: number }
  /** Keyframe Interpolation. Sets the interpolation of the keyframe at `frame` of an animated property. Changes the document. */
  "graph.setInterpolation": { /** The key's frame */ frame: number; /** The component, from 0 (0) */ index?: number; /** How the curve runs to the next key */ interpolation: "bezier" | "linear" | "constant"; /** The bone or shape key, for their properties */ path?: string; /** The channel's property (location, boneRotation, shapeKey, ...) */ property: string; /** The channel's object (or material) id */ target: number }
  /** Add Constraint. Adds a constraint (track to, copy location, IK, limit, child of, ...) with its settings to `object` or one of its bones. Changes the document. */
  "constraint.add": { /** action: the action's name */ action?: string; /** copyLocation and copyRotation: [x, y, z] axes copied */ axes?: Array<boolean>; /** floor: the plane's side the owner stays on */ axis?: "x" | "y" | "z" | "-x" | "-y" | "-z"; /** A bone of the owner (an armature) to constrain instead of the object; the active bone in pose mode */ bone?: string; /** stretchTo and splineIk: how strongly the other axes thin as it stretches, 0 to 100 (1 keeps the volume) */ bulge?: number; /** ik: bones in the chain counting this one, 0 runs to the root; splineIk: bones fitted to the curve (1) */ chain?: number; /** splineIk: keep the chain's root where it is */ chainOffset?: boolean; /** action: the target's channel that picks the frame */ channel?: "locationX" | "locationY" | "locationZ" | "rotationX" | "rotationY" | "rotationZ" | "scaleX" | "scaleY" | "scaleZ"; /** splineIk: the curve's radius scales the bones' thickness (true) */ curveRadius?: boolean; /** splineIk: share the curve evenly between the bones */ evenDivisions?: boolean; /** transform: map values beyond the source range too */ extrapolate?: boolean; /** action: the frame the channel's maximum plays */ frameEnd?: number; /** action: the frame the channel's minimum plays */ frameStart?: number; /** transform: the source range's high end [x, y, z] */ fromMax?: Array<number>; /** transform: the source range's low end (degrees for rotation) [x, y, z] */ fromMin?: Array<number>; /** How much of the result is used, 0 to 1 (1) */ influence?: number; /** copyLocation and copyRotation: [x, y, z] axes inverted */ invert?: Array<boolean>; /** ik: solver iterations (500) */ iterations?: number; /** stretchTo: how Y turns to the target */ keepAxis?: "swingY" | "planeX" | "planeZ"; /** limitRotation: [x, y, z] angles limited */ limit?: Array<boolean>; /** transform: the target's channel read */ mapFrom?: "location" | "rotation" | "scale"; /** transform: the owner's channel set */ mapTo?: "location" | "rotation" | "scale"; /** transform: for the owner's x, y, z, the target axis each reads */ mapping?: Array<"x" | "y" | "z">; /** limitRotation: highest angles, degrees [x, y, z]; action: the channel value that plays frameEnd */ max?: Json; /** limitRotation: lowest angles, degrees [x, y, z]; action: the channel value that plays frameStart (degrees for rotation) */ min?: Json; /** transform: add or replace (location), add, replace, before, or after (rotation), replace or multiply (scale); action: how the action combines with the owner */ mix?: "add" | "replace" | "before" | "after" | "multiply" | "beforeFull" | "beforeSplit" | "afterFull" | "afterSplit"; /** The owner; the active object when left out */ object?: Json; /** copyLocation: true adds to the owner's location; floor: metres beyond the plane */ offset?: number; /** copyLocation, copyRotation, transform: the space the owner is read in (pose and localWithParent on bones) */ ownerSpace?: "world" | "local" | "pose" | "localWithParent"; /** ik: the pole target object */ pole?: Json; /** ik: degrees the chain turns from the pole */ poleAngle?: number; /** ik: a bone of the pole target */ poleBone?: string; /** armature: blend the bones as dual quaternions */ preserveVolume?: boolean; /** Its name */ rename?: string; /** stretchTo: the distance, in the owner's Y units, at which it does not stretch; 0 takes the distance now */ restLength?: number; /** limitRotation: the space the angles are read in (pose and localWithParent on bones) */ space?: "world" | "local" | "pose" | "localWithParent"; /** The target object */ target?: Json; /** A bone of the target (an armature) to use instead of the object */ targetBone?: string; /** copyLocation, copyRotation, transform, action: the space the target is read in */ targetSpace?: "world" | "local" | "pose" | "localWithParent"; /** armature: the bones that move the owner, as { object, bone, weight } */ targets?: Array<{ [key: string]: Json }>; /** transform: the destination range's high end [x, y, z] */ toMax?: Array<number>; /** transform: the destination range's low end (degrees for rotation) [x, y, z] */ toMin?: Array<number>; /** trackTo and dampedTrack: the axis pointed at the target */ trackAxis?: "x" | "y" | "z" | "-x" | "-y" | "-z"; /** The constraint (ik and splineIk on bones) */ type: "trackTo" | "dampedTrack" | "copyLocation" | "copyRotation" | "limitRotation" | "childOf" | "ik" | "stretchTo" | "floor" | "transform" | "action" | "armature" | "splineIk"; /** trackTo: the axis kept up */ upAxis?: "x" | "y" | "z"; /** floor: the plane turns with the target */ useRotation?: boolean; /** stretchTo: the axes that thin */ volume?: "xzx" | "x" | "z" | "none"; /** splineIk: the bones' thickness */ xzScale?: "none" | "boneOriginal" | "inversePreserve" | "volumePreserve"; /** splineIk: the bones' lengths */ yScale?: "none" | "fitCurve" | "boneOriginal" }
  /** Change Constraint. Changes the settings of constraint `index` or `name`. Changes the document. */
  "constraint.set": { /** action: the action's name */ action?: string; /** copyLocation and copyRotation: [x, y, z] axes copied */ axes?: Array<boolean>; /** floor: the plane's side the owner stays on */ axis?: "x" | "y" | "z" | "-x" | "-y" | "-z"; /** A bone of the owner (an armature) to constrain instead of the object; the active bone in pose mode */ bone?: string; /** stretchTo and splineIk: how strongly the other axes thin as it stretches, 0 to 100 (1 keeps the volume) */ bulge?: number; /** ik: bones in the chain counting this one, 0 runs to the root; splineIk: bones fitted to the curve (1) */ chain?: number; /** splineIk: keep the chain's root where it is */ chainOffset?: boolean; /** action: the target's channel that picks the frame */ channel?: "locationX" | "locationY" | "locationZ" | "rotationX" | "rotationY" | "rotationZ" | "scaleX" | "scaleY" | "scaleZ"; /** splineIk: the curve's radius scales the bones' thickness (true) */ curveRadius?: boolean; /** On or off */ enabled?: boolean; /** splineIk: share the curve evenly between the bones */ evenDivisions?: boolean; /** transform: map values beyond the source range too */ extrapolate?: boolean; /** action: the frame the channel's maximum plays */ frameEnd?: number; /** action: the frame the channel's minimum plays */ frameStart?: number; /** transform: the source range's high end [x, y, z] */ fromMax?: Array<number>; /** transform: the source range's low end (degrees for rotation) [x, y, z] */ fromMin?: Array<number>; /** The constraint's position in the stack, from 0 */ index?: number; /** How much of the result is used, 0 to 1 (1) */ influence?: number; /** copyLocation and copyRotation: [x, y, z] axes inverted */ invert?: Array<boolean>; /** ik: solver iterations (500) */ iterations?: number; /** stretchTo: how Y turns to the target */ keepAxis?: "swingY" | "planeX" | "planeZ"; /** limitRotation: [x, y, z] angles limited */ limit?: Array<boolean>; /** transform: the target's channel read */ mapFrom?: "location" | "rotation" | "scale"; /** transform: the owner's channel set */ mapTo?: "location" | "rotation" | "scale"; /** transform: for the owner's x, y, z, the target axis each reads */ mapping?: Array<"x" | "y" | "z">; /** limitRotation: highest angles, degrees [x, y, z]; action: the channel value that plays frameEnd */ max?: Json; /** limitRotation: lowest angles, degrees [x, y, z]; action: the channel value that plays frameStart (degrees for rotation) */ min?: Json; /** transform: add or replace (location), add, replace, before, or after (rotation), replace or multiply (scale); action: how the action combines with the owner */ mix?: "add" | "replace" | "before" | "after" | "multiply" | "beforeFull" | "beforeSplit" | "afterFull" | "afterSplit"; /** The constraint's name (instead of index) */ name?: string; /** The owner; the active object when left out */ object?: Json; /** copyLocation: true adds to the owner's location; floor: metres beyond the plane */ offset?: number; /** copyLocation, copyRotation, transform: the space the owner is read in (pose and localWithParent on bones) */ ownerSpace?: "world" | "local" | "pose" | "localWithParent"; /** ik: the pole target object */ pole?: Json; /** ik: degrees the chain turns from the pole */ poleAngle?: number; /** ik: a bone of the pole target */ poleBone?: string; /** armature: blend the bones as dual quaternions */ preserveVolume?: boolean; /** A new name */ rename?: string; /** stretchTo: the distance, in the owner's Y units, at which it does not stretch; 0 takes the distance now */ restLength?: number; /** limitRotation: the space the angles are read in (pose and localWithParent on bones) */ space?: "world" | "local" | "pose" | "localWithParent"; /** The target object */ target?: Json; /** A bone of the target (an armature) to use instead of the object */ targetBone?: string; /** copyLocation, copyRotation, transform, action: the space the target is read in */ targetSpace?: "world" | "local" | "pose" | "localWithParent"; /** armature: the bones that move the owner, as { object, bone, weight } */ targets?: Array<{ [key: string]: Json }>; /** transform: the destination range's high end [x, y, z] */ toMax?: Array<number>; /** transform: the destination range's low end (degrees for rotation) [x, y, z] */ toMin?: Array<number>; /** trackTo and dampedTrack: the axis pointed at the target */ trackAxis?: "x" | "y" | "z" | "-x" | "-y" | "-z"; /** trackTo: the axis kept up */ upAxis?: "x" | "y" | "z"; /** floor: the plane turns with the target */ useRotation?: boolean; /** stretchTo: the axes that thin */ volume?: "xzx" | "x" | "z" | "none"; /** splineIk: the bones' thickness */ xzScale?: "none" | "boneOriginal" | "inversePreserve" | "volumePreserve"; /** splineIk: the bones' lengths */ yScale?: "none" | "fitCurve" | "boneOriginal" }
  /** Remove Constraint. Removes constraint `index` or `name`. Changes the document. */
  "constraint.remove": { /** A bone of the owner (an armature) to constrain instead of the object; the active bone in pose mode */ bone?: string; /** The constraint's position in the stack, from 0 */ index?: number; /** The constraint's name (instead of index) */ name?: string; /** The owner; the active object when left out */ object?: Json }
  /** Move Constraint. Moves constraint `index` or `name` to position `to` in the stack. Changes the document. */
  "constraint.move": { /** A bone of the owner (an armature) to constrain instead of the object; the active bone in pose mode */ bone?: string; /** The constraint's position in the stack, from 0 */ index?: number; /** The constraint's name (instead of index) */ name?: string; /** The owner; the active object when left out */ object?: Json; /** The new position, from 0 */ to: number }
  /** Apply Constraint. Applies constraint `index` or `name` to the transform and removes it. Changes the document. */
  "constraint.apply": { /** A bone of the owner (an armature) to constrain instead of the object; the active bone in pose mode */ bone?: string; /** The constraint's position in the stack, from 0 */ index?: number; /** The constraint's name (instead of index) */ name?: string; /** The owner; the active object when left out */ object?: Json }
  /** Set Inverse. Sets the inverse of a child-of constraint so the object stays where it is. Changes the document. */
  "constraint.setInverse": { /** A bone of the owner (an armature) to constrain instead of the object; the active bone in pose mode */ bone?: string; /** The constraint's position in the stack, from 0 */ index?: number; /** The constraint's name (instead of index) */ name?: string; /** The owner; the active object when left out */ object?: Json }
  /** Clear Inverse. Clears the inverse of a child-of constraint. Changes the document. */
  "constraint.clearInverse": { /** A bone of the owner (an armature) to constrain instead of the object; the active bone in pose mode */ bone?: string; /** The constraint's position in the stack, from 0 */ index?: number; /** The constraint's name (instead of index) */ name?: string; /** The owner; the active object when left out */ object?: Json }
  /** Weight Paint. Turns weight paint mode on or off for mesh `object`. */
  "mode.weightPaint": { /** The mesh; the active one when left out */ object?: Json; /** Weight paint on or off; toggles when left out */ on?: boolean }
  /** Paint Group. Sets the vertex group weight painting paints into, and answers it. */
  "paint.group": { /** The vertex group to paint (made on the first stroke) */ name: string }
  /** Brush Settings. Sets the weight paint brush (mode, weight, radius, strength, falloff, front faces only) and X mirror (`xMirror`, `topologyMirror`, `mirrorGroups`); answers them. */
  "paint.brush": { /** How the brush fades to its edge */ falloff?: "smooth" | "sphere" | "root" | "sharp" | "linear" | "constant"; /** Only vertices facing the view */ frontFacesOnly?: boolean; /** X mirror paints in the group of the mirrored name, Arm.L and Arm.R (true) */ mirrorGroups?: boolean; /** What a stroke does */ mode?: "draw" | "add" | "subtract" | "blur"; /** Radius in pixels (50) */ radius?: number; /** How much one dab changes, 0 to 1 (1) */ strength?: number; /** X mirror finds that vertex by the edges, for sides that differ in shape (false) */ topologyMirror?: boolean; /** The weight painted, 0 to 1 (1) */ weight?: number; /** Paint the vertex across X = 0 too (false) */ xMirror?: boolean }
  /** Weight Tool. Sets what the pointer does in weight paint: `tool` brush, linearGradient, radialGradient, or sampleWeight; answers it. */
  "paint.tool": { /** What the pointer does */ tool: "brush" | "linearGradient" | "radialGradient" | "sampleWeight" }
  /** Sample Weight. Sets the brush weight to the paint group's weight at viewport pixel `at` (the nearest vertex of the face there); answers it. */
  "paint.sample": { /** Viewport pixels [x, y] */ at: Array<number> }
  /** Gradient. Fills group `group` (the paint group without it) with a `kind` linear or radial gradient from viewport pixel `from` (full brush weight) to `to`, as one undo step. Changes the document. */
  "paint.gradient": { /** Where the full weight is, viewport pixels [x, y] */ from: Array<number>; /** The group; the paint group when left out */ group?: string; /** Along the line, or around the start (linear) */ kind?: "linear" | "radial"; /** Where it has faded out, viewport pixels [x, y] */ to: Array<number> }
  /** Paint Stroke. Paints weights into vertex group `group` along `points` with the current brush. Changes the document. */
  "paint.stroke": { /** The group to paint; the paint group when left out */ group?: string; /** The stroke's path in viewport pixels, as [x, y] pairs */ points: Array<Json> }
  /** Set Weights. Sets, adds or subtracts `weight` on vertices of group `group` directly. Changes the document. */
  "paint.vertices": { /** The group; the paint group when left out */ group?: string; /** How the weight is used (draw replaces) */ mode?: "draw" | "add" | "subtract"; /** The mesh; the painted or active one when left out */ object?: Json; /** Vertex indices */ vertices: Array<number>; /** The weight (1) */ weight?: number }
  /** Normalize All. Normalizes every vertex's weights to sum to 1, optionally keeping the active group. Changes the document. */
  "paint.normalizeAll": { /** Keep the paint group's weights and share the rest (true) */ lockActive?: boolean; /** The mesh; the painted or active one when left out */ object?: Json }
  /** Sculpt Mode. Turns sculpt mode on or off for mesh `object`. */
  "mode.sculpt": { /** The mesh; the active one when left out */ object?: Json; /** Sculpt on or off; toggles when left out */ on?: boolean }
  /** Brush Settings. Sets the sculpt brush (kind, radius, strength, falloff, auto-smooth) and answers it. */
  "sculpt.brush": { /** Smoothing after each dab, 0 to 1 */ autoSmooth?: number; /** How the brush fades to its edge */ falloff?: "smooth" | "sphere" | "root" | "sharp" | "linear" | "constant"; /** Only vertices facing the view */ frontFacesOnly?: boolean; /** The brush */ kind?: "draw" | "clayStrips" | "smooth" | "grab" | "inflate" | "crease" | "flatten" | "pinch" | "snakeHook" | "mask" | "drawFaceSets"; /** Radius in viewport pixels (50) */ radius?: number; /** Distance between dabs as a share of the radius (0.1) */ spacing?: number; /** Strength at the centre, 0 to 1 (0.5; 1 for grab, snake hook, crease, mask, draw face sets) */ strength?: number; /** The other direction: in instead of out, unmask instead of mask */ subtract?: boolean; /** Mirror dabs across the object's own [x, y, z] (x on) */ symmetry?: Array<boolean>; /** Pen pressure scales the strength (true) */ usePressure?: boolean }
  /** Sculpt Stroke. Sculpts along `points` (or a `drag`) with a brush. Changes the document. */
  "sculpt.stroke": { /** Smoothing after each dab, 0 to 1 */ autoSmooth?: number; /** Grab and snake hook with world points: how far the last point drags, in metres [x, y, z] */ drag?: Array<number>; /** How the brush fades to its edge */ falloff?: "smooth" | "sphere" | "root" | "sharp" | "linear" | "constant"; /** Only vertices facing the view */ frontFacesOnly?: boolean; /** The brush */ kind?: "draw" | "clayStrips" | "smooth" | "grab" | "inflate" | "crease" | "flatten" | "pinch" | "snakeHook" | "mask" | "drawFaceSets"; /** The stroke's path: [x, y] viewport pixels, or [x, y, z] world points on the surface */ points: Array<Json>; /** Pen pressure at each point, 0 to 1 */ pressures?: Array<number>; /** Radius in viewport pixels (50) */ radius?: number; /** Distance between dabs as a share of the radius (0.1) */ spacing?: number; /** Strength at the centre, 0 to 1 (0.5; 1 for grab, snake hook, crease, mask, draw face sets) */ strength?: number; /** The other direction: in instead of out, unmask instead of mask */ subtract?: boolean; /** Mirror dabs across the object's own [x, y, z] (x on) */ symmetry?: Array<boolean>; /** Pen pressure scales the strength (true) */ usePressure?: boolean; /** With world points: the radius in metres (0.25) */ worldRadius?: number }
  /** Invert Mask. Inverts the sculpt mask. Changes the document. */
  "sculpt.maskInvert": Record<string, never>
  /** Clear Mask. Clears the sculpt mask. Changes the document. */
  "sculpt.maskClear": Record<string, never>
  /** Fill Mask. Masks the whole mesh. Changes the document. */
  "sculpt.maskFill": Record<string, never>
  /** Smooth Mask. Smooths the sculpt mask's edges. Changes the document. */
  "sculpt.maskSmooth": Record<string, never>
  /** Sculpt Tool. Selects a sculpt tool and answers it. */
  "sculpt.tool": { /** The brush, or a box or lasso tool that masks, hides, or makes a face set */ tool: "brush" | "boxMask" | "lassoMask" | "boxHide" | "lassoHide" | "boxFaceSet" | "lassoFaceSet" }
  /** Dynamic Topology. Turns dynamic topology on or off and sets its detail mode and size. Changes the document. */
  "sculpt.dyntopo": { /** Relative: the longest edge in screen pixels (12) */ detailSize?: number; /** Dynamic topology on (cuts the mesh into triangles) or off */ enabled?: boolean; /** How the detail size is measured */ mode?: "relative" | "constant" | "brush"; /** Brush: the longest edge as a percentage of the brush radius (25) */ percent?: number; /** What a dab does to the edges under it */ refine?: "subdivideCollapse" | "subdivide" | "collapse"; /** Constant: edges per metre (12) */ resolution?: number }
  /** Detail Flood Fill. Remeshes the whole mesh to the dynamic topology detail size. Changes the document. */
  "sculpt.detailFlood": Record<string, never>
  /** Box or Lasso. Applies a box or lasso gesture (mask, hide, face set, trim) over screen `points`. Changes the document. */
  "sculpt.gesture": { /** What happens to what the shape encloses */ action: "mask" | "unmask" | "hide" | "show" | "faceSet"; /** Only what is seen, not what is behind it */ frontFacesOnly?: boolean; /** Work on what lies outside the shape instead */ outside?: boolean; /** [x, y] viewport pixels: a box's two corners or a lasso's outline */ points: Array<Json>; /** A box (two corners) or a lasso (the outline) */ shape?: "box" | "lasso"; /** mask: the mask value, 0 to 1 (1) */ value?: number }
  /** Face Set from Masked. Makes a face set from the masked faces. Changes the document. */
  "sculpt.faceSetsFromMask": Record<string, never>
  /** Face Set from Visible. Makes a face set from the visible faces. Changes the document. */
  "sculpt.faceSetsFromVisible": Record<string, never>
  /** Face Sets from Loose Parts. Makes one face set per loose part of the mesh. Changes the document. */
  "sculpt.faceSetsFromLooseParts": Record<string, never>
  /** Clear Face Sets. Removes every face set. Changes the document. */
  "sculpt.faceSetsClear": Record<string, never>
  /** Face Set Visibility. Shows, hides or isolates face set `faceSet` (or the one under `x`, `y`). Changes the document. */
  "sculpt.faceSetVisibility": { /** Hide the set, show only it, show every face, or toggle */ action?: "hide" | "isolate" | "showAll" | "toggle"; /** The face set's id (0 for faces in none) */ faceSet?: number; /** Or the face set under this viewport pixel: x (the pointer's when left out) */ x?: number; /** and y */ y?: number }
  /** Hide Face Set. Hides the face set under the pointer. Changes the document. */
  "sculpt.hideFaceSet": Record<string, never>
  /** Show Only Face Set. Shows only the face set under the pointer. Changes the document. */
  "sculpt.isolateFaceSet": Record<string, never>
  /** Show All Faces. Shows every hidden face again. Changes the document. */
  "sculpt.showAllFaces": Record<string, never>
  /** Voxel Remesh. Remeshes `object` with voxels of `voxelSize`. Changes the document. */
  "sculpt.remesh": { /** The mesh; the sculpted or active one when left out */ object?: Json; /** The size of the voxels the surface is rebuilt from, metres (0.1) */ voxelSize?: number }
  /** Multires Subdivide. Adds a multiresolution subdivision level to `object`. Changes the document. */
  "multires.subdivide": { /** The mesh; the sculpted or active one when left out */ object?: Json }
  /** Multires Unsubdivide. Recovers one quad subdivision level below the base mesh, preserving existing surfaces and detail. Requires a Multires modifier, manifold quad topology with a boundary corner or extraordinary interior vertex per component (at most 100000 base faces and 250000 highest-level faces), linearly subdivided UVs, and no vertex groups, shape keys, masks, face sets, hidden faces, seams or UV pins. Unsupported inputs leave the document unchanged. Changes the document. */
  "multires.unsubdivide": { /** The mesh; the sculpted or active one when left out */ object?: Json }
  /** Multires Rebuild Subdivisions. Recovers all complete quad subdivision levels, up to six, from a mesh with a Multires modifier and no existing levels. Disconnected components stop at their common depth. Preserves the input surface as the highest level; has the same topology and attribute restrictions as multires.unsubdivide. Changes the document. */
  "multires.rebuildSubdivisions": { /** The mesh; the sculpted or active one when left out */ object?: Json }
  /** Multires Delete Higher. Deletes the multiresolution levels above the current one. Changes the document. */
  "multires.deleteHigher": { /** The mesh; the sculpted or active one when left out */ object?: Json }
  /** Multires Apply Base. Applies the multiresolution detail to the base mesh's shape. Changes the document. */
  "multires.applyBase": { /** The mesh; the sculpted or active one when left out */ object?: Json }
  /** Multires Reshape. Copies the shape of object `from` into `object`'s multiresolution levels. Changes the document. */
  "multires.reshape": { /** A mesh with the highest level's vertices, whose shape is copied */ from: Json; /** The mesh; the sculpted or active one when left out */ object?: Json }
  /** Add Particle System. Adds a particle system (emitter or hair) with its settings to `object`. Changes the document. */
  "particles.add": { /** The share of speed kept on a bounce, 0 to 1 (0.5) */ bounce?: number; /** Hair: children per parent strand (10) */ childCount?: number; /** Hair: how far simple children spread round their parent, metres (0.2) */ childRadius?: number; /** Hair: child strands */ children?: "none" | "simple" | "interpolated"; /** Objects particles bounce off (ids or names; an empty list for none) */ colliders?: Json; /** Particles or parent strands (1000, at most 100000) */ count?: number; /** The vertex group whose weights set how densely particles and strands start (empty: everywhere alike) */ densityGroup?: string; /** Particles die where they hit a collider */ dieOnCollision?: boolean; /** How start points spread */ distribution?: "jittered" | "random"; /** Air drag: the share of speed lost per second */ drag?: number; /** Hair: dynamics simulated in the physics bake (true: on with the defaults, false: off; an object: its settings, turning it on) */ dynamics?: Json; /** Where particles start */ emitFrom?: "faces" | "verts" | "volume"; /** Emitter: the last frame particles are born (200) */ frameEnd?: number; /** Emitter: the first frame particles are born (1) */ frameStart?: number; /** How strongly the scene's gravity pulls (1) */ gravity?: number; /** Hair: strand length, metres (4) */ hairLength?: number; /** With renderAs object: the object copied at each particle (null for none) */ instanceObject?: Json; /** Emitter (particles that fly) or hair (strands) */ kind?: "emitter" | "hair"; /** Emitter: frames a particle lives (50) */ lifetime?: number; /** Emitter: how much of the lifetime may randomly be cut, 0 to 1 */ lifetimeRandom?: number; /** The system's name (ParticleSystem) */ name?: string; /** Start speed along the surface normal, m/s (1) */ normalVelocity?: number; /** The mesh; the active one when left out */ object?: Json; /** Start velocity along the emitter's axes, m/s [x, y, z] */ objectVelocity?: Array<number>; /** Start speed in a random direction, m/s */ randomVelocity?: number; /** How particles show */ renderAs?: "halo" | "object" | "none"; /** How far instances turn at random, 0 to 1 */ rotationRandom?: number; /** Different seeds give different, each repeatable, particles (0) */ seed?: number; /** Hair: segments per strand (5) */ segments?: number; /** Particle size (halo diameter, instance scale), metres (0.05) */ size?: number; /** How much of the size may randomly be taken off, 0 to 1 */ sizeRandom?: number; /** Hair: strand width at the root, metres (0.01) */ strandWidth?: number; /** Seconds simulated per frame (0.04) */ timestep?: number }
  /** Particle Settings. Changes particle system `system`'s settings. Changes the document. */
  "particles.set": { /** The share of speed kept on a bounce, 0 to 1 (0.5) */ bounce?: number; /** Hair: children per parent strand (10) */ childCount?: number; /** Hair: how far simple children spread round their parent, metres (0.2) */ childRadius?: number; /** Hair: child strands */ children?: "none" | "simple" | "interpolated"; /** Objects particles bounce off (ids or names; an empty list for none) */ colliders?: Json; /** Particles or parent strands (1000, at most 100000) */ count?: number; /** The vertex group whose weights set how densely particles and strands start (empty: everywhere alike) */ densityGroup?: string; /** Particles die where they hit a collider */ dieOnCollision?: boolean; /** How start points spread */ distribution?: "jittered" | "random"; /** Air drag: the share of speed lost per second */ drag?: number; /** Hair: dynamics simulated in the physics bake (true: on with the defaults, false: off; an object: its settings, turning it on) */ dynamics?: Json; /** Where particles start */ emitFrom?: "faces" | "verts" | "volume"; /** Emitter: the last frame particles are born (200) */ frameEnd?: number; /** Emitter: the first frame particles are born (1) */ frameStart?: number; /** How strongly the scene's gravity pulls (1) */ gravity?: number; /** Hair: strand length, metres (4) */ hairLength?: number; /** With renderAs object: the object copied at each particle (null for none) */ instanceObject?: Json; /** Emitter (particles that fly) or hair (strands) */ kind?: "emitter" | "hair"; /** Emitter: frames a particle lives (50) */ lifetime?: number; /** Emitter: how much of the lifetime may randomly be cut, 0 to 1 */ lifetimeRandom?: number; /** A new name for the system */ name?: string; /** Start speed along the surface normal, m/s (1) */ normalVelocity?: number; /** The mesh; the active one when left out */ object?: Json; /** Start velocity along the emitter's axes, m/s [x, y, z] */ objectVelocity?: Array<number>; /** Start speed in a random direction, m/s */ randomVelocity?: number; /** How particles show */ renderAs?: "halo" | "object" | "none"; /** How far instances turn at random, 0 to 1 */ rotationRandom?: number; /** Different seeds give different, each repeatable, particles (0) */ seed?: number; /** Hair: segments per strand (5) */ segments?: number; /** Particle size (halo diameter, instance scale), metres (0.05) */ size?: number; /** How much of the size may randomly be taken off, 0 to 1 */ sizeRandom?: number; /** Hair: strand width at the root, metres (0.01) */ strandWidth?: number; /** The system's index or name; the first when left out */ system?: Json; /** Seconds simulated per frame (0.04) */ timestep?: number }
  /** Remove Particle System. Removes particle system `system` from `object`. Changes the document. */
  "particles.remove": { /** The mesh; the active one when left out */ object?: Json; /** The system's index or name; the first when left out */ system?: Json }
  /** Convert Particles to Mesh. Converts particle system `system` into a mesh object. Changes the document. */
  "particles.convert": { /** The mesh; the active one when left out */ object?: Json; /** The system's index or name; the first when left out */ system?: Json }
  /** Particle Statistics. Answers particle system `system`'s counts (particles, alive, children) at `frame`. */
  "particles.stats": { /** The frame (the current one when left out) */ frame?: number; /** The mesh; the active one when left out */ object?: Json; /** The system's index or name; the first when left out */ system?: Json }
  /** Particle Edit Mode. Turns particle edit mode on or off for a hair system. */
  "mode.particleEdit": { /** The mesh; the active one when left out */ object?: Json; /** Particle Edit on or off; toggles when left out */ on?: boolean; /** The system's index or name; the first when left out */ system?: Json }
  /** Grooming Brush. Sets the grooming brush (comb, cut, length, puff, smooth, ...) and answers it. */
  "particleEdit.brush": { /** The grooming brush */ kind?: "comb" | "cut" | "length" | "puff" | "smooth"; /** Radius in viewport pixels (50) */ radius?: number; /** Strength, 0 to 1 (0.5) */ strength?: number; /** Length and puff the other way: shorten, flatten */ subtract?: boolean }
  /** Groom Stroke. Grooms hair along `points` with a brush. Changes the document. */
  "particleEdit.stroke": { /** The grooming brush */ kind?: "comb" | "cut" | "length" | "puff" | "smooth"; /** The stroke's path: [x, y] viewport pixels */ points: Array<Json>; /** Radius in viewport pixels (50) */ radius?: number; /** Strength, 0 to 1 (0.5) */ strength?: number; /** Length and puff the other way: shorten, flatten */ subtract?: boolean }
  /** Delete Edit. Deletes the grooming edits of the hair system. Changes the document. */
  "particleEdit.reset": Record<string, never>
  /** Share Presence. Shares this person's pointer and selection with collaborators; answers what it shares. */
  "presence.local": { /** The pointer in viewport pixels [x, y]; left out when it left the view */ pointer?: Array<number> }
  /** Other People. Tells the editor where other people's pointers and selections are, for drawing them. */
  "presence.peers": { /** presence/peers as the host sent it */ peers: Json }
  /** Place Other People. Answers where to draw other people's pointers in the viewport. */
  "presence.place": Record<string, never>
  /** Bezier. Adds a Bezier curve at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.curveBezier": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Size: the curve spans twice this (1) */ radius?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number> }
  /** Circle. Adds a Bezier circle curve at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.curveCircle": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Radius in metres (1) */ radius?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number> }
  /** Path. Adds a NURBS path curve at `location` (with rotation, scale and `name`) and answers its name and object id; name it to address it in the same run. Changes the document. */
  "add.curvePath": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Size: the path spans four times this (1) */ radius?: number; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number> }
  /** Text. Adds a text object with `body` and `size` at `location` and answers its name and object id. Changes the document. */
  "add.text": { /** The text ("Text") */ body?: string; /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale [x, y, z] */ scale?: Array<number>; /** The text's size (1) */ size?: number }
  /** Toggle Edit Mode. Toggles the active curve, text or lattice between object mode and its edit mode. */
  "mode.shape": Record<string, never>
  /** Curve Settings. Changes curve `object`: dimensions, resolution, extrude, bevel depth and resolution, fill, cyclic. Changes the document. */
  "curve.set": { /** The radius of the round profile swept along the curve, metres */ bevelDepth?: number; /** Segments in each quarter of the bevel's profile (4) */ bevelResolution?: number; /** Close every spline on itself */ cyclic?: boolean; /** 2d keeps the curve flat and fills closed splines */ dimensions?: "2d" | "3d"; /** Half the height the curve is extruded to, metres */ extrude?: number; /** Close the ends of an open bevelled curve */ fillCaps?: boolean; /** 3D: full or half profile; 2D: which faces fill a closed curve */ fillMode?: "full" | "half" | "both" | "front" | "back" | "none"; /** The curve or text; the active or edited one when left out */ object?: Json; /** Moves the curve along its normals, metres */ offset?: number; /** Samples per segment, for every spline (12) */ resolution?: number }
  /** Text Settings. Changes text `object`: body, font size, alignment, extrude, bevel, spacing. Changes the document. */
  "text.set": { /** Horizontal alignment of each line */ align?: "left" | "center" | "right"; /** The round edge's radius, metres */ bevelDepth?: number; /** Segments in the round edge (4) */ bevelResolution?: number; /** The text; a newline starts a new line */ body?: string; /** Letter spacing as a multiple of each advance (1) */ characterSpacing?: number; /** Half the thickness the letters are extruded to, metres */ extrude?: number; /** The font's name (only the bundled Inter is available) */ font?: string; /** Line distance as a multiple of the size (1) */ lineSpacing?: number; /** The curve or text; the active or edited one when left out */ object?: Json; /** Moves the text sideways, metres */ offsetX?: number; /** Moves the text up, metres */ offsetY?: number; /** Points per curved segment of each letter (12) */ resolution?: number; /** Slants the letters: x moves by shear ? y */ shear?: number; /** The text's size (1: the font's full height is one metre) */ size?: number; /** Space width as a multiple (1) */ wordSpacing?: number }
  /** Convert to Mesh. Converts curves and texts in `objects` (names or ids; the selection without it) into meshes. Changes the document. */
  "object.convertToMesh": { /** The curves and texts; the selected ones when left out */ objects?: Json }
  /** Set Splines. Replaces the splines of curve `object` with `splines` (points, handles, cyclic). Changes the document. */
  "curve.setSplines": { /** The curve or text; the active or edited one when left out */ object?: Json; /** Splines as {type: bezier|poly|nurbs, points: [{co: [x,y,z], left?, right?, leftType?, rightType?: auto|vector|aligned|free, radius?, tilt?, weight?}], cyclic?, resolution?, order?, endpoint?}; B?zier handles left out are automatic */ splines: Array<Json> }
  /** Select Points. Selects curve points by index in curve edit mode. */
  "curve.select": { /** Take them out of the selection */ deselect?: boolean; /** Add to the selection */ extend?: boolean; /** Control points, counted through the splines in order (handles go with their point) */ points?: Array<number> }
  /** Move Points. Moves the selected curve points by `offset`. Changes the document. */
  "curve.translate": { /** How far, in the curve's own axes, metres [x, y, z] */ offset: Array<number> }
  /** Extrude Points. Extrudes new points from the selected curve end points by `offset`. Changes the document. */
  "curve.extrude": { /** Where the new point goes from the end point; continues the spline when left out [x, y, z] */ offset?: Array<number> }
  /** Subdivide. Subdivides the segments between selected curve points. Changes the document. */
  "curve.subdivide": Record<string, never>
  /** Toggle Cyclic. Opens or closes the selected splines. Changes the document. */
  "curve.toggleCyclic": Record<string, never>
  /** Set Handle Type. Sets the selected points' handle type (auto, vector, aligned, free). Changes the document. */
  "curve.setHandleType": { /** The handles' type */ type: "auto" | "vector" | "aligned" | "free" }
  /** Delete Points. Deletes the selected curve points. Changes the document. */
  "curve.deletePoints": Record<string, never>
  /** Type Text. Types `text` at the caret of text object `object` in text edit mode. Changes the document. */
  "text.insert": { /** The curve or text; the active or edited one when left out */ object?: Json; /** What to type at the caret (or the end) */ text: string }
  /** Delete Characters. Deletes `count` characters backward (or forward) from the caret in text edit mode. Changes the document. */
  "text.delete": { /** How many (1) */ count?: number; /** Delete after the caret instead of before */ forward?: boolean }
  /** Move Caret. Moves the caret in text edit mode by `by`, to `to`, or to a place (start, end, line start, ...) and answers it. */
  "text.caret": { /** Characters to move (negative: back) */ by?: number; /** A place to go */ place?: "start" | "end" | "lineStart" | "lineEnd" | "up" | "down"; /** A character index */ to?: number }
  /** Lattice. Adds a lattice of `resolution` at `location` and answers its name and object id. Changes the document. */
  "add.lattice": { /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** The object's name */ name?: string; /** Points along each side, 1 to 64: one number for all three, or [u, v, w] */ resolution?: Json; /** Rotation in degrees, XYZ Euler [x, y, z] */ rotation?: Array<number>; /** Scale: the lattice spans this many metres along each axis (1) [x, y, z] */ scale?: Array<number> }
  /** Lattice Settings. Changes lattice `object`: resolution and interpolation, or resets its points. Changes the document. */
  "lattice.set": { /** How the points' offsets blend (bspline) */ interpolation?: "bspline" | "linear"; /** The lattice; the active or edited one when left out */ object?: Json; /** Put every point back where it rests */ reset?: boolean; /** Points along each side, 1 to 64: one number for all three, or [u, v, w] */ resolution?: Json }
  /** Move Lattice Points. Moves lattice points (by index, else the selected ones) by `offset`. Changes the document. */
  "lattice.movePoints": { /** The lattice; the active or edited one when left out */ object?: Json; /** How far to move them, in the lattice's own axes [x, y, z] */ offset: Array<number>; /** Point indices (u + v ? U + w ? U ? V); the selected points in edit mode when left out */ points?: Array<number> }
  /** Select Lattice Points. Selects lattice points by index in lattice edit mode. */
  "lattice.select": { /** Take them out of the selection */ deselect?: boolean; /** Add to the selection */ extend?: boolean; /** Point indices */ points?: Array<number> }
  /** Physics World. Sets the physics world: gravity, frame range, steps and iterations. Changes the document. */
  "physics.world.set": { /** The last simulated frame */ frameEnd?: number; /** The first simulated frame */ frameStart?: number; /** Gravity in m/s? (default 0, 0, -9.81) [x, y, z] */ gravity?: Array<number>; /** Solver iterations per step (1 to 100) */ iterations?: number; /** Simulation steps per frame (1 to 100) */ substeps?: number; /** How fast simulated time runs (0.01 to 100) */ timeScale?: number }
  /** Add Rigid Body. Makes `objects` (names or ids; the selection without it) rigid bodies (active or passive) with mass, shape, friction and damping. Changes the document. */
  "physics.rigidBody.add": { /** Angular damping, 0 to 1 */ angularDamping?: number; /** A passive body moved by its animation, pushing active ones */ animated?: boolean; /** Below this spin (rad/s) the body may fall asleep */ deactivateAngular?: number; /** Below this speed (m/s) the body may fall asleep */ deactivateLinear?: number; /** The body may fall asleep when it barely moves (and wakes when something hits it) */ deactivation?: boolean; /** Simulated (an active body that is not stays put) */ enabled?: boolean; /** Friction, 0 to 10 */ friction?: number; /** Linear damping, 0 to 1 */ linearDamping?: number; /** Collision margin in metres */ margin?: number; /** Mass in kg */ mass?: number; /** The objects; the selection when left out */ objects?: Json; /** Bounciness, 0 to 1 */ restitution?: number; /** The collision shape (mesh: passive bodies only) */ shape?: "box" | "sphere" | "capsule" | "cylinder" | "convexHull" | "mesh"; /** The body starts asleep, hanging where it is until something hits it */ startDeactivated?: boolean; /** Active bodies move; passive ones only collide */ type?: "active" | "passive" }
  /** Rigid Body Settings. Changes the rigid body settings of `objects` (names or ids; the selection without it). Changes the document. */
  "physics.rigidBody.set": { /** Angular damping, 0 to 1 */ angularDamping?: number; /** A passive body moved by its animation, pushing active ones */ animated?: boolean; /** Below this spin (rad/s) the body may fall asleep */ deactivateAngular?: number; /** Below this speed (m/s) the body may fall asleep */ deactivateLinear?: number; /** The body may fall asleep when it barely moves (and wakes when something hits it) */ deactivation?: boolean; /** Simulated (an active body that is not stays put) */ enabled?: boolean; /** Friction, 0 to 10 */ friction?: number; /** Linear damping, 0 to 1 */ linearDamping?: number; /** Collision margin in metres */ margin?: number; /** Mass in kg */ mass?: number; /** The objects; the selection when left out */ objects?: Json; /** Bounciness, 0 to 1 */ restitution?: number; /** The collision shape (mesh: passive bodies only) */ shape?: "box" | "sphere" | "capsule" | "cylinder" | "convexHull" | "mesh"; /** The body starts asleep, hanging where it is until something hits it */ startDeactivated?: boolean; /** Active bodies move; passive ones only collide */ type?: "active" | "passive" }
  /** Remove Rigid Body. Removes the rigid bodies from `objects` (names or ids; the selection without it). Changes the document. */
  "physics.rigidBody.remove": { /** The objects; the selection when left out */ objects?: Json }
  /** Add Cloth. Adds cloth simulation to `objects` (names or ids; the selection without it) with its stiffness and damping. Changes the document. */
  "physics.cloth.add": { /** Air damping */ airDamping?: number; /** Bending stiffness */ bending?: number; /** How close the cloth comes to collision objects, in metres */ collisionDistance?: number; /** Compression stiffness */ compression?: number; /** Mass of each vertex in kg */ mass?: number; /** The objects; the selection when left out */ objects?: Json; /** The vertex group that stays put (empty: none) */ pinGroup?: string; /** Steps per frame (1 to 80) */ quality?: number; /** The cloth collides with itself */ selfCollision?: boolean; /** How far apart the cloth keeps from itself, in metres */ selfDistance?: number; /** Shear stiffness */ shear?: number; /** Stretch stiffness */ tension?: number }
  /** Cloth Settings. Changes the cloth settings of `objects` (names or ids; the selection without it). Changes the document. */
  "physics.cloth.set": { /** Air damping */ airDamping?: number; /** Bending stiffness */ bending?: number; /** How close the cloth comes to collision objects, in metres */ collisionDistance?: number; /** Compression stiffness */ compression?: number; /** Mass of each vertex in kg */ mass?: number; /** The objects; the selection when left out */ objects?: Json; /** The vertex group that stays put (empty: none) */ pinGroup?: string; /** Steps per frame (1 to 80) */ quality?: number; /** The cloth collides with itself */ selfCollision?: boolean; /** How far apart the cloth keeps from itself, in metres */ selfDistance?: number; /** Shear stiffness */ shear?: number; /** Stretch stiffness */ tension?: number }
  /** Remove Cloth. Removes cloth from `objects` (names or ids; the selection without it). Changes the document. */
  "physics.cloth.remove": { /** The objects; the selection when left out */ objects?: Json }
  /** Add Soft Body. Adds a soft body to `objects` (names or ids; the selection without it) with its goal, edge springs, mass and friction. Changes the document. */
  "physics.softBody.add": { /** Self collision: each vertex's ball as a share of its edges' mean length (0.49) */ ballSize?: number; /** Springs between vertices two edges apart, 0 to 10 (0: none) */ bending?: number; /** Edge damping (0.5) */ damping?: number; /** Springs along the mesh's edges (on) */ edges?: boolean; /** The last simulated frame (250); after it the body holds */ frameEnd?: number; /** The first simulated frame (1); before it the mesh is at rest */ frameStart?: number; /** Air friction (0.5) */ friction?: number; /** Vertices are drawn to where the mesh puts them (on) */ goal?: boolean; /** Goal spring damping (0) */ goalDamping?: number; /** The goal weight, 0 to 1; 1 follows the mesh exactly (0.7) */ goalDefault?: number; /** The vertex group whose weights scale the goal (empty: every vertex alike) */ goalGroup?: string; /** The goal weight at group weight 1, 0 to 1 (1) */ goalMax?: number; /** The goal weight at group weight 0, 0 to 1 (0) */ goalMin?: number; /** Goal spring stiffness, 0 to 0.999 (0.5) */ goalStiffness?: number; /** Mass of each vertex in kg (1) */ mass?: number; /** The objects; the selection when left out */ objects?: Json; /** Edge stiffness when stretched, 0 to 0.999 (0.5) */ pull?: number; /** Edge stiffness when squeezed, 0 to 0.999 (0.5) */ push?: number; /** Vertices keep apart from each other (off) */ selfCollision?: boolean; /** How fast simulated time runs (1) */ speed?: number }
  /** Soft Body Settings. Changes the soft body settings of `objects` (names or ids; the selection without it). Changes the document. */
  "physics.softBody.set": { /** Self collision: each vertex's ball as a share of its edges' mean length (0.49) */ ballSize?: number; /** Springs between vertices two edges apart, 0 to 10 (0: none) */ bending?: number; /** Edge damping (0.5) */ damping?: number; /** Springs along the mesh's edges (on) */ edges?: boolean; /** The last simulated frame (250); after it the body holds */ frameEnd?: number; /** The first simulated frame (1); before it the mesh is at rest */ frameStart?: number; /** Air friction (0.5) */ friction?: number; /** Vertices are drawn to where the mesh puts them (on) */ goal?: boolean; /** Goal spring damping (0) */ goalDamping?: number; /** The goal weight, 0 to 1; 1 follows the mesh exactly (0.7) */ goalDefault?: number; /** The vertex group whose weights scale the goal (empty: every vertex alike) */ goalGroup?: string; /** The goal weight at group weight 1, 0 to 1 (1) */ goalMax?: number; /** The goal weight at group weight 0, 0 to 1 (0) */ goalMin?: number; /** Goal spring stiffness, 0 to 0.999 (0.5) */ goalStiffness?: number; /** Mass of each vertex in kg (1) */ mass?: number; /** The objects; the selection when left out */ objects?: Json; /** Edge stiffness when stretched, 0 to 0.999 (0.5) */ pull?: number; /** Edge stiffness when squeezed, 0 to 0.999 (0.5) */ push?: number; /** Vertices keep apart from each other (off) */ selfCollision?: boolean; /** How fast simulated time runs (1) */ speed?: number }
  /** Remove Soft Body. Removes the soft bodies from `objects` (names or ids; the selection without it). Changes the document. */
  "physics.softBody.remove": { /** The objects; the selection when left out */ objects?: Json }
  /** Add Collision. Makes `objects` (names or ids; the selection without it) colliders for cloth, soft bodies, hair, and particles (`damping` for how much they bounce). Changes the document. */
  "physics.collision.add": { /** How much of a soft body's bounce it takes, 0 to 1 (0.1) */ damping?: number; /** Friction against cloth and soft bodies */ friction?: number; /** The objects; the selection when left out */ objects?: Json; /** How far outside the surface cloth and soft bodies stay, in metres */ thickness?: number }
  /** Remove Collision. Removes collision from `objects` (names or ids; the selection without it). Changes the document. */
  "physics.collision.remove": { /** The objects; the selection when left out */ objects?: Json }
  /** New Force Field. Adds an empty with a force field (wind, vortex, force, turbulence, ...) at `location`. Changes the document. */
  "physics.field.new": { /** Strength falls off as (1 + distance)^-power (0: no falloff) */ falloffPower?: number; /** Things are carried along: they also slow by this share of their speed each second */ flow?: number; /** Drag: slowing in proportion to speed */ linearDrag?: number; /** Where to put it, in metres (the origin when left out) [x, y, z] */ location?: Array<number>; /** Beyond this distance it does nothing (0 or less: no limit) */ maxDistance?: number; /** Within this distance it is at full strength (0 or less: none) */ minDistance?: number; /** The new empty's name */ name?: string; /** Drag: slowing in proportion to speed squared */ quadraticDrag?: number; /** Rotation in degrees, XYZ Euler (wind and vortex act along its Z) [x, y, z] */ rotation?: Array<number>; /** Turbulence: different seeds give different noise */ seed?: number; /** Turbulence: the size of its swirls in metres */ size?: number; /** How hard it pushes (m/s? on a particle at full strength; drag ignores it) */ strength?: number; /** force: away from the origin (towards it when negative); wind: along the object's Z; vortex: round its Z; turbulence: noise; drag: slows things */ type?: "force" | "wind" | "vortex" | "turbulence" | "drag" }
  /** Add Force Field. Adds a force field to `objects` (names or ids; the selection without it). Changes the document. */
  "physics.field.add": { /** Strength falls off as (1 + distance)^-power (0: no falloff) */ falloffPower?: number; /** Things are carried along: they also slow by this share of their speed each second */ flow?: number; /** Drag: slowing in proportion to speed */ linearDrag?: number; /** Beyond this distance it does nothing (0 or less: no limit) */ maxDistance?: number; /** Within this distance it is at full strength (0 or less: none) */ minDistance?: number; /** The objects; the selection when left out */ objects?: Json; /** Drag: slowing in proportion to speed squared */ quadraticDrag?: number; /** Turbulence: different seeds give different noise */ seed?: number; /** Turbulence: the size of its swirls in metres */ size?: number; /** How hard it pushes (m/s? on a particle at full strength; drag ignores it) */ strength?: number; /** force: away from the origin (towards it when negative); wind: along the object's Z; vortex: round its Z; turbulence: noise; drag: slows things */ type?: "force" | "wind" | "vortex" | "turbulence" | "drag" }
  /** Force Field Settings. Changes the force field settings of `objects` (names or ids; the selection without it). Changes the document. */
  "physics.field.set": { /** Strength falls off as (1 + distance)^-power (0: no falloff) */ falloffPower?: number; /** Things are carried along: they also slow by this share of their speed each second */ flow?: number; /** Drag: slowing in proportion to speed */ linearDrag?: number; /** Beyond this distance it does nothing (0 or less: no limit) */ maxDistance?: number; /** Within this distance it is at full strength (0 or less: none) */ minDistance?: number; /** The objects; the selection when left out */ objects?: Json; /** Drag: slowing in proportion to speed squared */ quadraticDrag?: number; /** Turbulence: different seeds give different noise */ seed?: number; /** Turbulence: the size of its swirls in metres */ size?: number; /** How hard it pushes (m/s? on a particle at full strength; drag ignores it) */ strength?: number; /** force: away from the origin (towards it when negative); wind: along the object's Z; vortex: round its Z; turbulence: noise; drag: slows things */ type?: "force" | "wind" | "vortex" | "turbulence" | "drag" }
  /** Remove Force Field. Removes the force fields from `objects` (names or ids; the selection without it). Changes the document. */
  "physics.field.remove": { /** The objects; the selection when left out */ objects?: Json }
  /** Add Rigid Body Constraint. Adds a rigid body constraint (fixed, hinge, slider, spring, motor, ...) between two objects. A motor independently drives translation and rotation on the constraint X axis. Changes the document. */
  "physics.constraint.add": { /** Hinge: [lower, upper] in degrees about Z, or null for none */ angleLimit?: Array<Json>; /** Generic spring: per axis X, Y, Z a [lower, upper] in degrees, or null for free */ angularLimits?: Array<Json>; /** Motor: maximum angular impulse control, 0 to 1000000000 (default 1); step impulse is value times seconds */ angularMaxImpulse?: number; /** Motor: enable rotation about the constraint's X axis (default false) */ angularMotor?: boolean; /** Generic spring: per axis X, Y, Z a stiffness in N?m/rad, or null for none */ angularSprings?: Array<Json>; /** Motor: body 1 relative to body 2 in rad/s, -100000 to 100000 (default 1) */ angularTargetVelocity?: number; /** The constraint breaks when it must push harder than the threshold */ breakable?: boolean; /** The impulse (N?s) in one step that breaks it */ breakingThreshold?: number; /** The joined bodies pass through each other (default true) */ disableCollisions?: boolean; /** Slider: [lower, upper] in metres along X, or null for none */ distanceLimit?: Array<Json>; /** The constraint acts */ enabled?: boolean; /** Generic spring: per axis X, Y, Z a [lower, upper] in metres, or null for free */ linearLimits?: Array<Json>; /** Motor: maximum linear impulse control, 0 to 1000000000 (default 1); step impulse is value times seconds */ linearMaxImpulse?: number; /** Motor: enable translation along the constraint's X axis (default false) */ linearMotor?: boolean; /** Generic spring: per axis X, Y, Z a stiffness in N/m, or null for none */ linearSprings?: Array<Json>; /** Motor: body 1 relative to body 2 in m/s, -100000 to 100000 (default 1) */ linearTargetVelocity?: number; /** The first rigid body joined */ object1?: Json; /** The second rigid body joined */ object2?: Json; /** The objects; the selection when left out */ objects?: Json; /** Generic spring: the springs' damping */ springDamping?: number; /** fixed: one piece; point: a ball joint; hinge: turns about Z; slider: slides along X; genericSpring: per axis limits and springs; motor: drives along/about X */ type?: "fixed" | "point" | "hinge" | "slider" | "genericSpring" | "motor" }
  /** Rigid Body Constraint Settings. Changes a rigid body constraint's settings. Changes the document. */
  "physics.constraint.set": { /** Hinge: [lower, upper] in degrees about Z, or null for none */ angleLimit?: Array<Json>; /** Generic spring: per axis X, Y, Z a [lower, upper] in degrees, or null for free */ angularLimits?: Array<Json>; /** Motor: maximum angular impulse control, 0 to 1000000000 (default 1); step impulse is value times seconds */ angularMaxImpulse?: number; /** Motor: enable rotation about the constraint's X axis (default false) */ angularMotor?: boolean; /** Generic spring: per axis X, Y, Z a stiffness in N?m/rad, or null for none */ angularSprings?: Array<Json>; /** Motor: body 1 relative to body 2 in rad/s, -100000 to 100000 (default 1) */ angularTargetVelocity?: number; /** The constraint breaks when it must push harder than the threshold */ breakable?: boolean; /** The impulse (N?s) in one step that breaks it */ breakingThreshold?: number; /** The joined bodies pass through each other (default true) */ disableCollisions?: boolean; /** Slider: [lower, upper] in metres along X, or null for none */ distanceLimit?: Array<Json>; /** The constraint acts */ enabled?: boolean; /** Generic spring: per axis X, Y, Z a [lower, upper] in metres, or null for free */ linearLimits?: Array<Json>; /** Motor: maximum linear impulse control, 0 to 1000000000 (default 1); step impulse is value times seconds */ linearMaxImpulse?: number; /** Motor: enable translation along the constraint's X axis (default false) */ linearMotor?: boolean; /** Generic spring: per axis X, Y, Z a stiffness in N/m, or null for none */ linearSprings?: Array<Json>; /** Motor: body 1 relative to body 2 in m/s, -100000 to 100000 (default 1) */ linearTargetVelocity?: number; /** The first rigid body joined */ object1?: Json; /** The second rigid body joined */ object2?: Json; /** The objects; the selection when left out */ objects?: Json; /** Generic spring: the springs' damping */ springDamping?: number; /** fixed: one piece; point: a ball joint; hinge: turns about Z; slider: slides along X; genericSpring: per axis limits and springs; motor: drives along/about X */ type?: "fixed" | "point" | "hinge" | "slider" | "genericSpring" | "motor" }
  /** Remove Rigid Body Constraint. Removes rigid body constraints from `objects` (names or ids; the selection without it). Changes the document. */
  "physics.constraint.remove": { /** The objects; the selection when left out */ objects?: Json }
  /** Connect Rigid Bodies. Connects `objects` (names or ids; the selection without it) pairwise with rigid body constraints of `type`. Changes the document. */
  "physics.constraint.connect": { /** Rigid bodies to join one to the next, in order; the selection when left out */ objects?: Json; /** The kind of constraint (default fixed) */ type?: "fixed" | "point" | "hinge" | "slider" | "genericSpring" | "motor" }
  /** Bake Physics. Bakes the physics simulation over the frame range; answers the cache state. Without anything simulated it fails. */
  "physics.bake": { /** Bake every frame now (default); false starts a bake that physics.bakeStep runs */ wait?: boolean }
  /** Bake Physics Step. Bakes `frames` more frames of the simulation and answers the cache state. */
  "physics.bakeStep": { /** Frames to bake now (default 4) */ frames?: number }
  /** Free Physics Bake. Frees the baked physics cache and answers its state. */
  "physics.free": Record<string, never>
  /** New Node Group. Creates a node group (geometry, shader, compositor) for a modifier, material, world or as a library group. Changes the document. */
  "nodes.newGroup": { /** shader: the material (id or name) the group gives its surface (a Principled BSDF into the Material Output's Surface) */ material?: Json; /** With object: the Geometry Nodes modifier (its index) to use the group instead of adding one */ modifier?: number; /** The group's name (Geometry Nodes, Shader, or Volume when left out) */ name?: string; /** geometry: add a Geometry Nodes modifier using the group to this mesh object */ object?: Json; /** geometry (the default): a Geometry Nodes group; shader: a material's surface and volume */ tree?: "geometry" | "shader"; /** shader: the group is the world's volume (a Principled Volume into the Material Output's Volume) */ world?: boolean }
  /** Remove Node Group. Deletes node group `group`. Changes the document. */
  "nodes.removeGroup": { /** The group's id or name; the only group when left out */ group?: Json }
  /** Rename Node Group. Renames node group `group`. Changes the document. */
  "nodes.renameGroup": { /** The group's id or name; the only group when left out */ group?: Json; /** The new name */ name: string }
  /** Add Node. Adds a node of `kind` (see `nodes.describe`) to `group` at `location` with input `values`. Changes the document. */
  "nodes.addNode": { /** The group's id or name; the only group when left out */ group?: Json; /** The node's kind (nodes.describe lists their sockets) */ kind: "groupInput" | "groupOutput" | "group" | "repeatInput" | "repeatOutput" | "simulationInput" | "simulationOutput" | "meshCube" | "meshGrid" | "meshUvSphere" | "meshIcoSphere" | "meshCylinder" | "meshCone" | "meshLine" | "meshCircle" | "curveLine" | "curveCircle" | "curveBezierSegment" | "curveQuadrilateral" | "curveSpiral" | "curveStar" | "curveToMesh" | "curveToPoints" | "fillCurve" | "resampleCurve" | "trimCurve" | "reverseCurve" | "setCurveRadius" | "setCurveTilt" | "setSplineCyclic" | "setSplineResolution" | "splineParameter" | "curveLength" | "endpointSelection" | "transform" | "joinGeometry" | "setPosition" | "deleteGeometry" | "mergeByDistance" | "subdivideMesh" | "subdivisionSurface" | "extrudeMesh" | "meshToPoints" | "meshToCurve" | "distributePointsOnFaces" | "pointsToVertices" | "instanceOnPoints" | "realizeInstances" | "setMaterial" | "storeNamedAttribute" | "captureAttribute" | "position" | "normal" | "index" | "value" | "vector" | "objectInfo" | "separateXyz" | "combineXyz" | "math" | "vectorMath" | "randomValue" | "compare" | "switch" | "mapRange" | "sceneTime" | "namedAttribute" | "domainSize" | "attributeStatistic" | "accumulateField" | "meshBoolean" | "dualMesh" | "flipFaces" | "splitEdges" | "triangulate" | "scaleElements" | "meshIsland" | "edgeAngle" | "faceArea" | "edgeNeighbors" | "sampleIndex" | "sampleNearest" | "raycast" | "geometryProximity" | "translateInstances" | "rotateInstances" | "scaleInstances" | "instanceRotation" | "instanceScale" | "rotateEuler" | "rotateRotation" | "rotateVector" | "eulerToRotation" | "rotationToEuler" | "axisAngleToRotation" | "invertRotation" | "renderLayers" | "image" | "rgb" | "compositorOutput" | "viewer" | "alphaOver" | "brightContrast" | "colorBalance" | "exposure" | "hueSaturation" | "invert" | "mixColor" | "rgbCurves" | "blur" | "denoise" | "glare" | "defocus" | "vectorBlur" | "kuwahara" | "cryptomatte" | "chromaKey" | "colorKey" | "differenceKey" | "distanceKey" | "keying" | "luminanceKey" | "ellipseMask" | "lensDistortion" | "crop" | "flip" | "rotate" | "scale" | "imageTransform" | "translate" | "materialOutput" | "textureCoordinate" | "geometryInfo" | "fresnel" | "layerWeight" | "principledBsdf" | "diffuseBsdf" | "glossyBsdf" | "glassBsdf" | "transparentBsdf" | "emission" | "volumeAbsorption" | "volumeScatter" | "principledVolume" | "mixShader" | "addShader" | "imageTexture" | "noiseTexture" | "voronoiTexture" | "gradientTexture" | "checkerTexture" | "waveTexture" | "colorRamp" | "separateColor" | "combineColor" | "mapping" | "bump" | "normalMap"; /** [x, y] in the editor's units */ location?: Array<number>; /** Socket and setting values by id, as nodes.setValue takes them */ values?: { [key: string]: Json } }
  /** Remove Nodes. Removes nodes by index from `group`. Changes the document. */
  "nodes.removeNodes": { /** The group's id or name; the only group when left out */ group?: Json; /** The nodes' ids */ nodes: Array<number> }
  /** Move Nodes. Moves nodes of `group` to `location` or by `offset` in the node editor. Changes the document. */
  "nodes.moveNodes": { /** The group's id or name; the only group when left out */ group?: Json; /** [x, y] to put the (one) node at */ location?: Array<number>; /** The nodes' ids */ nodes: Array<number>; /** [dx, dy] to move each by */ offset?: Array<number> }
  /** Set Node Value. Sets input or property `id` of node `node` in `group` to `value`. Changes the document. */
  "nodes.setValue": { /** The group's id or name; the only group when left out */ group?: Json; /** An input socket's or a setting's id */ id: string; /** The node's id */ node: number; /** The value: a number, [x, y, z], a boolean, a setting's choice, an object or material id, a text; null clears it */ value?: Json }
  /** Link Sockets. Links output socket `fromSocket` of node `from` to input socket `toSocket` of node `to` in `group`. Changes the document. */
  "nodes.link": { /** The node whose output to link */ from: number; /** The output socket's id */ fromSocket: string; /** The group's id or name; the only group when left out */ group?: Json; /** The node whose input to link */ to: number; /** The input socket's id; a link already there is replaced unless the input takes several */ toSocket: string }
  /** Unlink Sockets. Removes the link between two sockets in `group`. Changes the document. */
  "nodes.unlink": { /** Only the link from this node */ from?: number; /** Only the link from this output socket */ fromSocket?: string; /** The group's id or name; the only group when left out */ group?: Json; /** The node whose input to unlink */ to: number; /** The input socket's id */ toSocket: string }
  /** Add Group Input. Adds an input socket of `type` to node group `group`'s interface. Changes the document. */
  "nodes.addInput": { /** The value a modifier uses when it sets none */ default?: Json; /** The group's id or name; the only group when left out */ group?: Json; /** The input's name, unique in the group */ name: string; /** What the input carries */ type: "geometry" | "float" | "int" | "bool" | "vector" | "rotation" | "object" | "material" | "string" }
  /** Remove Group Input. Removes input `name` from node group `group`'s interface. Changes the document. */
  "nodes.removeInput": { /** The group's id or name; the only group when left out */ group?: Json; /** The input's name */ name: string }
  /** Add Group Output. Adds an output socket of `type` to node group `group`'s interface. Changes the document. */
  "nodes.addOutput": { /** The group's id or name; the only group when left out */ group?: Json; /** The output's name, unique in the group (a Group node using the group gives it) */ name: string; /** What the output carries */ type: "geometry" | "float" | "int" | "bool" | "vector" | "rotation" }
  /** Remove Group Output. Removes output `name` from node group `group`'s interface. Changes the document. */
  "nodes.removeOutput": { /** The group's id or name; the only group when left out */ group?: Json; /** The output's name */ name: string }
  /** Add Zone Item. Adds an item to a repeat or simulation zone node's state. Changes the document. */
  "nodes.addZoneItem": { /** The group's id or name; the only group when left out */ group?: Json; /** The item's name, unique in the zone: a socket on both of its nodes */ name: string; /** Either node of the zone */ node: number; /** What the item carries */ type: "geometry" | "float" | "int" | "bool" | "vector" | "rotation" }
  /** Remove Zone Item. Removes an item from a repeat or simulation zone node's state. Changes the document. */
  "nodes.removeZoneItem": { /** The group's id or name; the only group when left out */ group?: Json; /** The item's name */ name: string; /** Either node of the zone */ node: number }
  /** Describe Node Kinds. Lists the node kinds a tree takes (or one `kind`) with their inputs, outputs and properties, for `nodes.addNode`. */
  "nodes.describe": { /** The group's id or name; the only group when left out */ group?: Json; /** One kind; every kind when left out */ kind?: string; /** Only the kinds a geometry, a compositing, or a shader group takes */ tree?: "geometry" | "compositor" | "shader" }
  /** New Compositor. Creates a compositing node group and uses it for renders when `use`. Changes the document. */
  "compositor.new": { /** The group's name (Compositing when left out) */ name?: string; /** Make renders pass through it (true) */ use?: boolean }
  /** Compositing. Turns compositing on or off and sets which group renders use. Changes the document. */
  "compositor.set": { /** Whether renders pass through the group */ compositing?: boolean; /** The compositing group renders pass through: its id or name; null for none */ group?: Json }
  /** Set Compositing Image. Sets the image an image node of the compositing group reads (workspace path or base64). Changes the document. */
  "compositor.setImage": { /** The image file's bytes, base64 */ base64?: string; /** Take the node's picture away */ clear?: boolean; /** The compositing group (the one renders use when left out) */ group?: Json; /** An image the scene has already, by its hash */ image?: string; /** The image's name, with base64 */ name?: string; /** The Image node's id */ node: number; /** An image file (PNG, JPEG, or Radiance HDR) to read */ path?: Json }
  /** Pick Matte. Adds the name under `x`, `y` of the render to a Cryptomatte node's matte (or takes it away with `remove`). Changes the document. */
  "compositor.pickMatte": { /** The compositing group (the one renders use when left out) */ group?: Json; /** The Cryptomatte node's id */ node: number; /** Take the name away from the matte instead (false) */ remove?: boolean; /** Across the render, 0 (left) to 1 (right) */ x: number; /** Down the render, 0 (top) to 1 (bottom) */ y: number }
  /** Preview Compositing. Answers the compositing group's result (or a viewer node) as a picture of `size`. */
  "compositor.preview": { /** A compositing group to preview other than the render's */ group?: Json; /** The longer side of the preview in pixels, 16 to 2048 (480) */ size?: number; /** Answer what the Viewer node shows instead of the output (false) */ viewer?: boolean }
}

/** A Cube file opened with `openDocument<Scene, CubeCommands>`. */
export type CubeDocument = ModelDocument<Scene, CubeCommands>
export type CubeContext = RequestContext<Scene, CubeCommands>
