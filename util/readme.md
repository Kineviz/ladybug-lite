## ladybug-lite
A lightweight fork of the [Ladybug](https://github.com/LadybugDB/ladybug) (formerly Kùzu) embedded graph database, optimized for faster installation and broader compatibility.

### Why We Forked Ladybug

- ***Large Package Size:*** 
The official Ladybug npm package can be sizable, resulting in slow downloads and build times, particularly outside Europe and North America.
**ladybug-lite** strips it down to essential binaries for a smaller, faster package.

- ***No Alpine Linux Support:***
 Ladybug doesn't support Alpine Linux out of the box, which we rely on for Docker image. 
 **ladybug-lite** includes musl libc-compatible binaries to work seamlessly with lightweight containers.


### Benefits

- ***Speed:*** Quicker downloads and builds.

- ***Compatibility:*** Full support for Alpine Linux.

- ***Efficiency:*** Retains Ladybug's core functionality in a leaner package.

This version is straightforward, highlights the key issues with the official Ladybug package, and explains the advantages of **ladybug-lite** in a way that's easy for users to understand. Feel free to tweak it as needed!
