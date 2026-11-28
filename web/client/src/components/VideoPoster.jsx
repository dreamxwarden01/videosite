import { useLayoutEffect, useRef, useState } from 'react';
import { createPosterLoader, posterIdentity } from '../services/posterLoader';

const PlayIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>;

function PosterImage(props) {
  const [image, setImage] = useState({ phase: 'idle', id: null, src: null });
  const loader = useRef(null);
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    const current = createPosterLoader({ onChange: setImage });
    loader.current = current;
    current.update(latest.current);
    return () => { current.dispose(); loader.current = null; };
  }, []);
  useLayoutEffect(() => {
    loader.current?.update(props);
  }, [props.courseId, props.videoId, props.domain, props.path, props.ready, props.token, props.status, props.revision]);

  if (image.phase !== 'loading' && image.phase !== 'loaded') {
    return <div className="vs-cv-play"><PlayIcon /></div>;
  }
  const loaded = image.phase === 'loaded';
  return (
    <div className={`vs-cv-thumb${loaded ? '' : ' loading'}`}>
      <img key={image.id} src={image.src} alt="" loading="lazy" style={{ opacity: loaded ? 1 : 0 }}
        onLoad={() => loader.current?.loaded(image.id)}
        onError={() => loader.current?.failed(image.id)} />
    </div>
  );
}

export default function VideoPoster(props) {
  // Clear the image immediately on server reset, including already loaded
  // images and callbacks from requests made before replacement/cancellation.
  if (props.ready !== true) return <div className="vs-cv-play"><PlayIcon /></div>;
  return <PosterImage key={posterIdentity(props)} {...props} />;
}
