/** Side-effect CSS imports in the renderer entries. */
declare module '*.css'

/** CSS Modules consumed from companion sources (petween-physics cards). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
