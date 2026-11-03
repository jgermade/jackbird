import { useEffect, useRef } from "react";
import { Component79 } from "jq79";

type Jq79IslandProps = {
  /** A jq79 component, as imported from its .html file. */
  component: Component79;
  className?: string;
};

/**
 * Mounts a jq79 view inside the React tree, for as long as React is still
 * here: an element React owns, a clone of the component mounted into it, and
 * the clone destroyed when React unmounts it. The view reads the lib/ stores
 * itself, so it takes no props.
 */
export function Jq79Island(props: Jq79IslandProps): JSX.Element {
  const { component, className } = props;
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) {
      return;
    }
    const instance = new Component79(component).mount(host.current);
    return () => {
      instance.destroy();
    };
  }, [component]);

  return <div ref={host} className={className} />;
}
