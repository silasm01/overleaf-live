#!/bin/bash
# Builds the libraries of the TeXpresso engine for WASM (Emscripten) into /opt/wasm/sysroot
set -euo pipefail
export PATH=/opt/wasm/emscripten:$PATH
P=/opt/wasm/sysroot; S=/opt/wasm/src; B=/opt/wasm/build/deps
mkdir -p $P $B
export CFLAGS="-O2" CXXFLAGS="-O2"
export PKG_CONFIG_PATH=$P/lib/pkgconfig PKG_CONFIG_LIBDIR=$P/lib/pkgconfig
done_() { [ -f $P/lib/$1 ]; }
cm() { local name=$1; shift; emcmake cmake -S $S/$name -B $B/$name -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$P -DCMAKE_FIND_ROOT_PATH=$P -DCMAKE_PREFIX_PATH=/ -DBUILD_SHARED_LIBS=OFF -DZLIB_LIBRARY=$P/lib/libz.a -DZLIB_INCLUDE_DIR=$P/include -DPNG_LIBRARY=$P/lib/libpng16.a -DPNG_PNG_INCLUDE_DIR=$P/include "$@" >$B/${name//\//_}.log 2>&1; ninja -C $B/$name install >>$B/${name//\//_}.log 2>&1; echo "ok $name"; }
[ -f $P/lib/libz.a ] || (cd $S/zlib && git checkout -q zconf.h 2>/dev/null; emconfigure ./configure --static --prefix=$P >$B/zlib.log 2>&1 && emmake make -j2 install >>$B/zlib.log 2>&1) && echo "ok zlib"
rm -f $P/lib/libz.so* 
done_ libpng16.a || cm libpng -DPNG_SHARED=OFF -DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DZLIB_ROOT=$P
done_ libfreetype.a || cm freetype -DFT_DISABLE_BZIP2=ON -DFT_DISABLE_BROTLI=ON -DFT_DISABLE_HARFBUZZ=ON -DFT_REQUIRE_ZLIB=ON -DFT_REQUIRE_PNG=ON -DZLIB_ROOT=$P
done_ libgraphite2.a || cm graphite -DGRAPHITE2_COMPARE_RENDERER=OFF -DGRAPHITE2_NTRACING=ON
done_ libexpat.a || cm libexpat/expat -DEXPAT_BUILD_TOOLS=OFF -DEXPAT_BUILD_EXAMPLES=OFF -DEXPAT_BUILD_TESTS=OFF -DEXPAT_SHARED_LIBS=OFF

# ICU: Emscripten port (stub data: no locale line breaking yet)
cat > $P/lib/pkgconfig/icu-uc.pc <<PC
Name: icu-uc
Description: ICU (Emscripten port)
Version: 74.2
Libs: -licu_common -licu_stubdata
Cflags:
PC
# meson cross file
cat > $B/cross.txt <<X
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
pkg-config = 'pkg-config'
[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
[properties]
needs_exe_wrapper = true
X
ms() { local name=$1; shift; meson setup --cross-file $B/cross.txt --prefix=$P --default-library=static --buildtype=release $B/$name $S/$name "$@" >$B/$name.log 2>&1; ninja -C $B/$name install >>$B/$name.log 2>&1; echo "ok $name"; }
if [ ! -d $S/fontconfig ]; then
  (cd $S && curl -sSL http://archive.ubuntu.com/ubuntu/pool/main/f/fontconfig/fontconfig_2.15.0.orig.tar.xz | tar xJ && mv fontconfig-2.15.0 fontconfig)
fi
done_ libfontconfig.a || ms fontconfig -Dtests=disabled -Dtools=disabled -Ddoc=disabled -Dnls=disabled -Dcache-build=disabled
done_ libharfbuzz.a || ms harfbuzz -Dgraphite2=enabled -Dicu=enabled -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled -Dtests=disabled -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled
