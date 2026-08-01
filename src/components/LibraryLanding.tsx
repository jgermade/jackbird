type LibraryLandingProps = {
  onOpenFolder: () => void;
};

export function LibraryLanding(props: LibraryLandingProps): JSX.Element {
  return (
    <section className="library-landing">
      <div className="library-landing-mark" aria-hidden="true">
        MP3
      </div>
      <h2>Tu biblioteca, donde ya esta</h2>
      <p>
        Abre una carpeta de musica para explorar sus albumes, revisar sus metadatos y editar
        caratulas sin subir los archivos a ningun sitio.
      </p>
      <button type="button" className="btn btn-primary" onClick={props.onOpenFolder}>
        Abrir carpeta
      </button>
      <small>Los cambios se escriben directamente en tus archivos MP3.</small>
    </section>
  );
}
