class ZipBuilder {
    constructor() {
        this.files = [];
        this.offset = 0;
        this.opfsRoot = null;
        this.opfsFileHandle = null;
        this.opfsWritable = null;
        this.tempFileName = `temp_zip_${Date.now()}.zip`;
    }

    async init() {
        if (!this.opfsWritable) {
            this.opfsRoot = await navigator.storage.getDirectory();
            this.opfsFileHandle = await this.opfsRoot.getFileHandle(this.tempFileName, { create: true });
            this.opfsWritable = await this.opfsFileHandle.createWritable();
        }
    }

    async writeChunk(data) {
        await this.opfsWritable.write(data);
        this.offset += data.byteLength;
    }

    async addFile(name, blob, onProgress, signal) {
        await this.init();
        
        const encoder = new TextEncoder();
        const nameBytes = encoder.encode(name);
        
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(localHeader.buffer);
        
        const dosTime = ZipBuilder.toDosDateTime(new Date());
        
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0x0808, true); 
        view.setUint16(8, 0, true); 
        view.setUint32(10, dosTime, true);
        view.setUint32(14, 0, true); 
        view.setUint32(18, 0, true); 
        view.setUint32(22, 0, true); 
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true); 
        
        localHeader.set(nameBytes, 30);
        
        const localHeaderOffset = this.offset;
        await this.writeChunk(localHeader);
        
        let crc = 0; 
        let size = 0;
        
        const stream = blob.stream();
        const reader = stream.getReader();
        
        const crcTable = window.crcTable || (function() {
            let c;
            let crcTable = [];
            for(let n =0; n < 256; n++){
                c = n;
                for(let k =0; k < 8; k++){
                    c = ((c&1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
                }
                crcTable[n] = c;
            }
            window.crcTable = crcTable;
            return crcTable;
        })();

        let currentCrc = 0 ^ (-1); let lastYield = performance.now(); while (true) { if (performance.now() - lastYield > 50) { await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); } if (signal && signal.aborted) { reader.cancel(); return false; } const { done, value } = await reader.read(); if (done) break; await this.writeChunk(value); size += value.byteLength; for (let i = 0; i < value.length; i++ ) { currentCrc = (currentCrc >>> 8) ^ crcTable[(currentCrc ^ value[i]) & 0xFF]; } if (typeof onProgress === "function") { onProgress(size); } }
        
        crc = (currentCrc ^ (-1)) >>> 0;
        
        const descriptor = new Uint8Array(16);
        const descView = new DataView(descriptor.buffer);
        descView.setUint32(0, 0x08074b50, true);
        descView.setUint32(4, crc, true);
        descView.setUint32(8, size, true);
        descView.setUint32(12, size, true);
        
        await this.writeChunk(descriptor);
        
        this.files.push({
            nameBytes,
            dosTime,
            crc,
            compressedSize: size,
            uncompressedSize: size,
            localHeaderOffset,
            compressionMethod: 0
        });
    }

    async generateBlob() {
        await this.init();
        
        const centralDirOffset = this.offset;
        let centralDirSize = 0;

        for (const file of this.files) {
            const centralHeader = new Uint8Array(46 + file.nameBytes.length);
            const cv = new DataView(centralHeader.buffer);
            cv.setUint32(0, 0x02014b50, true); 
            cv.setUint16(4, 20, true);         
            cv.setUint16(6, 20, true);         
            cv.setUint16(8, 0x0808, true);
            cv.setUint16(10, file.compressionMethod, true);
            cv.setUint32(12, file.dosTime, true);
            cv.setUint32(16, file.crc, true);
            cv.setUint32(20, file.compressedSize, true);
            cv.setUint32(24, file.uncompressedSize, true);
            cv.setUint16(28, file.nameBytes.length, true);
            cv.setUint16(30, 0, true);         
            cv.setUint16(32, 0, true);         
            cv.setUint16(34, 0, true);         
            cv.setUint16(36, 0, true);         
            cv.setUint32(38, 0, true);         
            cv.setUint32(42, file.localHeaderOffset, true);    
            centralHeader.set(file.nameBytes, 46);

            await this.writeChunk(centralHeader);
            centralDirSize += centralHeader.length;
        }

        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);     
        ev.setUint16(4, 0, true);             
        ev.setUint16(6, 0, true);             
        ev.setUint16(8, this.files.length, true); 
        ev.setUint16(10, this.files.length, true); 
        ev.setUint32(12, centralDirSize, true); 
        ev.setUint32(16, centralDirOffset, true); 
        ev.setUint16(20, 0, true);            

        await this.writeChunk(eocd);
        
        await this.opfsWritable.close();
        this.opfsWritable = null;

        const file = await this.opfsFileHandle.getFile();
        
        // Expose a method to clean up OPFS file when done
        file.dispose = async () => { await this.dispose(); }; return file; } async dispose() { if (this.opfsWritable) { try { await this.opfsWritable.close(); } catch(e){} this.opfsWritable = null; } if (this.opfsRoot && this.tempFileName) { try { await this.opfsRoot.removeEntry(this.tempFileName); } catch (e) {} } }

    static toDosDateTime(d) {
        const year = Math.max(1980, d.getFullYear());
        const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        return ((date << 16) | time) >>> 0;
    }
}

if (typeof window !== 'undefined') {
    window.ZipBuilder = ZipBuilder;
}








