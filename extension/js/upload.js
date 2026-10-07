if (typeof window.escapeHTML !== 'function') {
    window.escapeHTML = function(str) {
        if (typeof str !== 'string') return str;
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag]));
    };
}
/**
 * FetchStream Manual Upload Page Controller
 * Handles batch file/folder drag-and-drop, client-side ZIP packaging,
 * per-item service selection, sequential uploads, and real-time progress tracking.
 */

document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const selectFilesBtn = document.getElementById('selectFilesBtn');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const serviceSelect = document.getElementById('serviceSelect');
    const serviceHelp = document.getElementById('serviceHelp');
    const manualServiceMode = document.getElementById('manualServiceMode');
    const editDefaultCustomListBtn = document.getElementById('editDefaultCustomListBtn');
    
        const serverUrlInput = document.getElementById('serverUrlInput');
    const serverUrlFileNameInput = document.getElementById('serverUrlFileNameInput');
    const urlFetchSpinner = document.getElementById('urlFetchSpinner');
    const urlUploadServiceSelectBtn = document.getElementById('urlUploadServiceSelectBtn');
    const urlUploadServiceSelectText = document.getElementById('urlUploadServiceSelectText');
    const urlUploadDropdownMenu = document.getElementById('urlUploadDropdownMenu');
    const serverUploadStateBadge = document.getElementById('serverUploadStateBadge');
    let hasUserGesture = false;
    const markUserGesture = () => { hasUserGesture = true; };
    document.addEventListener('pointerdown', markUserGesture, { once: true, capture: true });
    document.addEventListener('keydown', markUserGesture, { once: true, capture: true });
    document.addEventListener('touchstart', markUserGesture, { once: true, capture: true });
    
    let selectedUrlUploadService = "gofile.io";

    const updateServerUploadState = async () => {
        if (!serverUploadStateBadge || typeof Vault === 'undefined') return;
        const state = await Vault.getServerUploadState();
        const serverUploadSubmitBtn = document.getElementById('serverUploadSubmitBtn');
        if (serverUploadSubmitBtn) {
            serverUploadSubmitBtn.disabled = !state.isReady;
            serverUploadSubmitBtn.style.opacity = state.isReady ? '1' : '0.55';
            serverUploadSubmitBtn.style.filter = state.isReady ? 'none' : 'grayscale(100%)';
        }
        serverUploadStateBadge.innerHTML = `<i class="bi ${state.icon} me-1"></i><span>${state.label}</span>`;
        serverUploadStateBadge.className = `btn btn-link btn-sm text-decoration-none px-0 mt-1 text-start ${state.isReady ? 'text-success' : state.state === 'LOCKED' ? 'text-danger' : 'text-warning'}`;
        serverUploadStateBadge.onclick = async () => {
            try {
                if (state.state === 'SETUP_REQUIRED' || state.state === 'LOCKED') {
                    const password = await CustomDialog.prompt(
                        state.state === 'SETUP_REQUIRED' ? 'Create a master passphrase for the Vault:' : 'Enter your master passphrase to unlock the Vault:',
                        state.state === 'SETUP_REQUIRED' ? 'Set Up Vault' : 'Unlock Vault',
                        'info',
                        'password'
                    );
                    if (!password) return;
                    if (state.state === 'SETUP_REQUIRED') await Vault.setup(password, {});
                    else await Vault.unlock(password);
                    await updateServerUploadState();
                    return;
                }

                if (state.state === 'RELAY_REQUIRED') {
                    const relayUrl = await CustomDialog.prompt('Enter your Server Relay URL:', 'Add Server Relay URL', 'info', 'url');
                    if (!relayUrl || !relayUrl.trim()) return;
                    const currentCreds = await Vault.getUnlockedCreds() || {};
                    await Vault.updateCredsIfUnlocked({ ...currentCreds, serverRelayUrl: relayUrl.trim() });
                    await updateServerUploadState();
                }
            } catch (error) {
                await CustomDialog.alert(error.message || 'Could not update Vault state.', 'Vault', 'danger');
            }
        };
    };
    updateServerUploadState();
    document.addEventListener('vaultStateChanged', updateServerUploadState);
    if (chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'session' && (changes.fs_vault_unlocked || changes.fs_vault_key)) {
                updateServerUploadState();
            }
        });
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local' && changes.fs_vault) updateServerUploadState();
        });
    }

    const serviceIncludesTelegram = (service, customList = []) => {
        if (service === 'telegram' || service === 'all') return true;
        if (Array.isArray(customList) && customList.includes('telegram')) return true;
        return typeof service === 'string' && service.split(',').map(s => s.trim()).includes('telegram');
    };
    
    if (urlUploadDropdownMenu) {
        const multiHostBtn = document.getElementById('multiHostBtn');
        if (multiHostBtn) {
            multiHostBtn.onclick = () => {
                const currentList = uploadConfig.customList || ["gofile.io", "buzzheavier.com"];
                window.openMultiHostModal('url', currentList, (selectedList) => {
                    uploadConfig.customList = selectedList;
                    selectedUrlUploadService = "custom";
                    if (urlUploadServiceSelectText) {
                        urlUploadServiceSelectText.innerHTML = '<i class="bi bi-check2-square me-1.5 text-primary"></i> Custom Multi-Host <small class="text-muted">(' + selectedList.length + ' hosts)</small>';
                    }
                    const urlCaptionContainer = document.getElementById('urlUploadCaptionContainer');
                    if (urlCaptionContainer) urlCaptionContainer.classList.toggle('d-none', !serviceIncludesTelegram('custom', selectedList));
                });
            };
        }

        const items = urlUploadDropdownMenu.querySelectorAll('.dropdown-item[data-service]');
        items.forEach(btn => {
            btn.onclick = () => {
                selectedUrlUploadService = btn.getAttribute('data-service');
                if (urlUploadServiceSelectText) {
                    urlUploadServiceSelectText.innerHTML = btn.innerHTML;
                }
                
                const urlCaptionContainer = document.getElementById('urlUploadCaptionContainer');
                if (urlCaptionContainer) {
                    if (selectedUrlUploadService === 'telegram' || selectedUrlUploadService === 'all') {
                        urlCaptionContainer.classList.remove('d-none');
                    } else {
                        urlCaptionContainer.classList.add('d-none');
                    }
                }
            };
        });
    }
    async function fetchFilenameForUrl(url) {
        if (!url) return;
        try {
            new URL(url);
            urlFetchSpinner.classList.remove('d-none');
            
            const headResp = await fetch(url, { method: 'HEAD' });
            const disposition = headResp.headers.get('content-disposition');
            let fileName = '';
            if (disposition && disposition.includes('filename=')) {
                let match = disposition.match(/filename="?([^";]+)"?/);
                if (match && match[1]) fileName = decodeURIComponent(match[1]);
            }
            if (!fileName) {
                const parsed = new URL(url);
                const parts = parsed.pathname.split('/');
                const last = parts[parts.length - 1];
                if (last && last.indexOf('.') > -1) fileName = decodeURIComponent(last);
            }
            
            const isM3u8 = url.split('?')[0].toLowerCase().endsWith('.m3u8');
            if (isM3u8) {
                if (!fileName) fileName = 'stream';
                fileName = fileName.replace('.m3u8', '') + '.mp4';
            }
            
            if (fileName) {
                let baseName = fileName;
                let currentExt = "";
                const dotIdx = fileName.lastIndexOf(".");
                if (dotIdx > 0 && dotIdx < fileName.length - 1) {
                    baseName = fileName.substring(0, dotIdx);
                    currentExt = fileName.substring(dotIdx);
                }
                serverUrlFileNameInput.value = baseName;
                serverUrlFileNameInput.dataset.ext = currentExt;

                if (!serverUrlFileNameInput.parentNode.classList.contains("input-group")) {
                    const group = document.createElement("div");
                    group.className = "input-group input-group-sm mb-2 mt-2";
                    serverUrlFileNameInput.parentNode.insertBefore(group, serverUrlFileNameInput);
                    group.appendChild(serverUrlFileNameInput);
                    const extSpan = document.createElement("span");
                    extSpan.className = "input-group-text fw-semibold text-muted font-monospace";
                    extSpan.style.fontSize = "0.75rem";
                    extSpan.id = "serverUrlFileNameExt";
                    group.appendChild(extSpan);
                }
                const extEl = document.getElementById("serverUrlFileNameExt");
                if (extEl) extEl.textContent = currentExt;
                serverUrlFileNameInput.parentNode.style.display = 'flex';
                serverUrlFileNameInput.style.display = 'block';
            }
            
            if (isM3u8) {
                try {
                    const m3u8Resp = await fetch(url);
                    if (m3u8Resp.ok) {
                        const manifest = await m3u8Resp.text();
                        
                        // Parse variants
                        const lines = manifest.split('\n');
                        const variants = [];
                        let currentRes = '', currentBw = 0, currentLabel = '';
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                                const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                                if (resMatch) currentRes = resMatch[1];
                                const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                                if (bwMatch) currentBw = parseInt(bwMatch[1], 10);
                                const nameMatch = line.match(/NAME="([^"]+)"/);
                                if (nameMatch) currentLabel = nameMatch[1];
                            } else if (line && !line.startsWith('#')) {
                                const isAbsolute = line.startsWith('http://') || line.startsWith('https://');
                                let finalUrl = line;
                                if (!isAbsolute) {
                                    try {
                                        const b = new URL(url);
                                        const pathParts = b.pathname.split('/');
                                        pathParts.pop();
                                        finalUrl = line.startsWith('/') ? b.origin + line : b.origin + pathParts.join('/') + '/' + line;
                                    } catch(e){}
                                }
                                variants.push({ url: finalUrl, resolution: currentRes, bandwidth: currentBw, label: currentLabel || `Variant ${variants.length + 1}` });
                                currentRes = ''; currentBw = 0; currentLabel = '';
                            }
                        }
                        
                        const variantsContainer = document.getElementById("urlUploadVariantsContainer");
                        const variantSelect = document.getElementById("urlUploadVariantSelect");
                        const watchBtn = document.getElementById("urlUploadWatchBtn");
                        
                        if (variantsContainer && variantSelect && variants.length > 0) {
                            variantSelect.innerHTML = "";
                            variants.forEach((v) => {
                                const opt = document.createElement("option");
                                opt.value = v.url;
                                opt.textContent = `${v.resolution || v.label} (${v.bandwidth ? formatBytes(v.bandwidth) + '/s' : 'Auto'})`;
                                opt.dataset.resolution = v.resolution || v.label;
                                variantSelect.appendChild(opt);
                            });
                            variantsContainer.classList.remove('d-none');
                            variantsContainer.classList.remove('d-none');
                        } else if (variantsContainer) {
                            variantsContainer.classList.add('d-none');
                        }
                    }
                } catch(e) {}
            } else {
                const variantsContainer = document.getElementById("urlUploadVariantsContainer");
                if (variantsContainer) variantsContainer.classList.add('d-none');
            }
            
            urlFetchSpinner.classList.add('d-none');
        } catch(e) {
            urlFetchSpinner.classList.add('d-none');
        }
    }
    
    if (serverUrlInput) {
        serverUrlInput.addEventListener('blur', () => fetchFilenameForUrl(serverUrlInput.value.trim()));
        serverUrlInput.addEventListener('paste', () => {
            setTimeout(() => fetchFilenameForUrl(serverUrlInput.value.trim()), 100);
        });
    }

    const urlUploadAudioOnlyCheckbox = document.getElementById('urlUploadAudioOnlyCheckbox');
    const urlUploadVariantSelect = document.getElementById('urlUploadVariantSelect');
    if (urlUploadAudioOnlyCheckbox && urlUploadVariantSelect) {
        urlUploadAudioOnlyCheckbox.addEventListener('change', () => {
            if (urlUploadAudioOnlyCheckbox.checked) {
                urlUploadVariantSelect.disabled = true;
                urlUploadVariantSelect.style.opacity = "0.5";
            } else {
                urlUploadVariantSelect.disabled = false;
                urlUploadVariantSelect.style.opacity = "1";
            }
        });
    }

    const serverUploadSubmitBtn = document.getElementById('serverUploadSubmitBtn');
    
    const startUploadBtn = document.getElementById('startUploadBtn');
    const pauseAllBtn = document.getElementById('pauseAllBtn');
    const cancelAllBtn = document.getElementById('cancelAllBtn');
    const clearQueueBtn = document.getElementById('clearQueueBtn');
    
    const queueList = document.getElementById('queueList');
    const emptyQueue = document.getElementById('emptyQueue');
    const queueCount = document.getElementById('queueCount');
    
    const summaryDiv = document.getElementById('uploadSummary');
    const summaryText = document.getElementById('summaryText');
    const summaryPercent = document.getElementById('summaryPercent');
    const summaryProgress = document.getElementById('summaryProgress');
    
    const zipNotice = document.getElementById('zipNotice');
    const zipNoticeText = document.getElementById('zipNoticeText');
    const cancelZipBtn = document.getElementById('cancelZipBtn');
    let currentZipAbortController = null;
    if (cancelZipBtn) {
        cancelZipBtn.addEventListener('click', () => {
            if (currentZipAbortController) currentZipAbortController.abort();
        });
    }

    let uploadConfig = { service: 'all', customList: ["gofile.io", "buzzheavier.com"], credentials: {} };
    let fileQueue = [];
    let isUploading = false;
    let isQueuePaused = false;
    let currentActiveItem = null;

    // Load saved options
    chrome.storage.local.get(['options'], (res) => {
        const opts = res.options || (typeof OPTION !== 'undefined' ? OPTION : {});
        if (typeof normalizeUploadDestinationOptions === 'function') normalizeUploadDestinationOptions(opts);
        uploadConfig.credentials = opts.upload?.credentials || {};
        uploadConfig.customList = [...(opts.serverUpload?.customList || ["gofile.io", "buzzheavier.com"])] ;
        
        // Default to saved service if not local, or keep 'all'
        const saved = opts.serverUpload?.service || 'gofile.io';
        if (saved) {
            const opt = serviceSelect.querySelector(`option[value="${saved}"]`);
            if (opt && !opt.disabled) {
                serviceSelect.value = saved;
            }
        }
                uploadConfig.service = serviceSelect.value;
        if (typeof selectedUrlUploadService !== 'undefined' && urlUploadDropdownMenu && uploadConfig.service !== 'local') {
            selectedUrlUploadService = uploadConfig.service;
            const targetBtn = urlUploadDropdownMenu.querySelector(`.dropdown-item[data-service="${uploadConfig.service}"]`);
            if (targetBtn && urlUploadServiceSelectText) {
                urlUploadServiceSelectText.innerHTML = targetBtn.innerHTML;
            } else if (uploadConfig.service === 'custom' && urlUploadServiceSelectText) {
                urlUploadServiceSelectText.innerHTML = '<i class="bi bi-check2-square me-1.5 text-primary"></i> Custom Multi-Host <small class="text-muted">(' + uploadConfig.customList.length + ' hosts)</small>';
            }
            const urlCaptionContainer = document.getElementById('urlUploadCaptionContainer');
            if (urlCaptionContainer) {
                if (serviceIncludesTelegram(selectedUrlUploadService, uploadConfig.customList)) {
                    urlCaptionContainer.classList.remove('d-none');
                } else {
                    urlCaptionContainer.classList.add('d-none');
                }
            }
        }
        updateServiceHint();
        const initialManualCaption = document.getElementById('manualUploadCaptionContainer');
        if (initialManualCaption) {
            initialManualCaption.classList.toggle('d-none', !serviceIncludesTelegram(uploadConfig.service, uploadConfig.customList));
        }
    });

    serviceSelect.addEventListener('change', () => {
        uploadConfig.service = serviceSelect.value;
        
        if (serviceSelect.value === 'custom') {
            const currentList = uploadConfig.customList || ["gofile.io", "buzzheavier.com"];
            window.openMultiHostModal('manual', currentList, (selectedList) => {
                uploadConfig.customList = selectedList;
                updateServiceHint();
                fileQueue.forEach(item => {
                    if (!manualServiceMode?.checked && item.status === 'pending' && !item.customServiceSet) {
                        item.service = 'custom';
                        const selectEl = item.el?.querySelector('.item-service-select');
                        if (selectEl) selectEl.value = 'custom';
                    }
                });
            });
        }
        if (typeof selectedUrlUploadService !== 'undefined' && urlUploadDropdownMenu && uploadConfig.service !== 'local') {
            selectedUrlUploadService = uploadConfig.service;
            const targetBtn = urlUploadDropdownMenu.querySelector(`.dropdown-item[data-service="${uploadConfig.service}"]`);
            if (targetBtn && urlUploadServiceSelectText) {
                urlUploadServiceSelectText.innerHTML = targetBtn.innerHTML;
            }
            const urlCaptionContainer = document.getElementById('urlUploadCaptionContainer');
            if (urlCaptionContainer) {
                if (serviceIncludesTelegram(selectedUrlUploadService, uploadConfig.customList)) {
                    urlCaptionContainer.classList.remove('d-none');
                } else {
                    urlCaptionContainer.classList.add('d-none');
                }
            }
        }
        
        const manualCaptionContainer = document.getElementById('manualUploadCaptionContainer');
        if (manualCaptionContainer) {
            if (serviceIncludesTelegram(uploadConfig.service, uploadConfig.customList)) {
                manualCaptionContainer.classList.remove('d-none');
            } else {
                manualCaptionContainer.classList.add('d-none');
            }
        }

        updateServiceHint();
        fileQueue.forEach(item => {
            if (item.status === 'pending' && !item.customServiceSet) {
                item.service = manualServiceMode?.checked ? '' : serviceSelect.value;
                const selectEl = item.el?.querySelector('.item-service-select');
                if (selectEl) selectEl.value = item.service;
                const captionContainer = item.el?.querySelector('.item-caption-container');
                if (captionContainer) {
                    if (serviceIncludesTelegram(item.service, item.customList || uploadConfig.customList)) {
                        captionContainer.classList.remove('d-none');
                    } else {
                        captionContainer.classList.add('d-none');
                    }
                }
            }
        });
    });

    if (manualServiceMode) {
        manualServiceMode.onchange = () => {
            const manual = manualServiceMode.checked;
            fileQueue.forEach(item => {
                if (item.status === 'pending' && !item.customServiceSet) {
                    item.service = manual ? '' : serviceSelect.value;
                    const selectEl = item.el?.querySelector('.item-service-select');
                    if (selectEl) selectEl.value = item.service;
                    updateItemUI(item);
                }
            });
            updateUI();
        };
    }

    if (editDefaultCustomListBtn) {
        editDefaultCustomListBtn.onclick = () => {
            window.openMultiHostModal('manual', uploadConfig.customList, (selectedList) => {
                uploadConfig.customList = selectedList;
                if (serviceSelect.value === 'custom') serviceSelect.dispatchEvent(new Event('change'));
                updateServiceHint();
                fileQueue.forEach(item => {
                    if (item.status === 'pending' && !item.customServiceSet && item.service === 'custom') {
                        updateItemUI(item);
                    }
                });
            });
        };
    }

    async function confirmLargeFolder(folderName, totalBytes) {
        const sizeStr = formatBytes(totalBytes);
        const modalEl = document.getElementById('largeFolderModal');
        if (modalEl && typeof bootstrap !== 'undefined' && bootstrap.Modal) {
            const nameEl = document.getElementById('largeFolderName');
            const sizeEl = document.getElementById('largeFolderSize');
            if (nameEl) nameEl.textContent = `"${folderName}"`;
            if (sizeEl) sizeEl.textContent = sizeStr;

            const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
            const proceedBtn = document.getElementById('proceedLargeFolderBtn');
            const cancelBtn = document.getElementById('cancelLargeFolderBtn');

            return new Promise((resolve) => {
                let resolved = false;
                const onProceed = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        modal.hide();
                        resolve(true);
                    }
                };
                const onCancel = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        modal.hide();
                        resolve(false);
                    }
                };
                const onHidden = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        resolve(false);
                    }
                };
                function cleanup() {
                    proceedBtn?.removeEventListener('click', onProceed);
                    cancelBtn?.removeEventListener('click', onCancel);
                    modalEl.removeEventListener('hidden.bs.modal', onHidden);
                }

                proceedBtn?.addEventListener('click', onProceed);
                cancelBtn?.addEventListener('click', onCancel);
                modalEl.addEventListener('hidden.bs.modal', onHidden);

                modal.show();
            });
        } else {
            const msg = `⚠️ Large Folder Warning (>100MB)\n\nThe selected folder "${folderName}" contains ${sizeStr} of files.\n\nCreating a ZIP archive of folders over 100MB directly inside your browser tab may cause high RAM usage or crash the browser.\n\nIt is strongly advised to compress this folder into a .zip file using your computer's ZIP tool first, then upload that .zip file directly.\n\nDo you want to proceed with in-browser packaging anyway?`;
            return Promise.resolve(await CustomDialog.confirm(msg));
        }
    }

    function updateServiceHint() {
        const val = serviceSelect.value;
        if (val === 'all') {
            serviceHelp.textContent = 'Uploads simultaneously to GoFile, Buzzheavier, FuckingFast, Storage.to, and Catbox.';
        } else if (val === 'custom') {
            serviceHelp.textContent = `Using ${uploadConfig.customList.length} selected destinations as the default.`;
        } else {
            serviceHelp.textContent = `Using ${val} as default upload destination.`;
        }
        if (editDefaultCustomListBtn) editDefaultCustomListBtn.classList.toggle('d-none', val !== 'custom');
    }

    // Format bytes
    function formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }

    const ALL_WORKING_UPLOAD_SERVICES = "gofile.io,buzzheavier.com,fuckingfast.co,storage.to,catbox.moe,pixeldrain.com,telegram,s3_compatible";

    // URL to Cloud Server Upload
    function getUrlUploadDetails() {
        let url = serverUrlInput.value.trim();
        if (!url) return null;
        const variantsContainer = document.getElementById("urlUploadVariantsContainer");
        const variantSelect = document.getElementById("urlUploadVariantSelect");
        let resolution = null;
        let variantUrl = null;
        if (variantsContainer && !variantsContainer.classList.contains("d-none") && variantSelect && variantSelect.value) {
            variantUrl = variantSelect.value;
            resolution = variantSelect.options[variantSelect.selectedIndex]?.dataset?.resolution;
        }
        const parsed = new URL(url);
        const isM3u8 = parsed.pathname.toLowerCase().endsWith('.m3u8');
        let fileName = serverUrlFileNameInput.value.trim();
        if (fileName && serverUrlFileNameInput.dataset.ext) {
            fileName += serverUrlFileNameInput.dataset.ext;
        }
        if (!fileName) {
            const pathParts = parsed.pathname.split('/');
            fileName = pathParts.pop() || (isM3u8 ? 'stream.mp4' : 'download.mp4');
            if (isM3u8 && fileName.endsWith('.m3u8')) fileName = fileName.replace('.m3u8', '.mp4');
        }
        let service = typeof selectedUrlUploadService !== 'undefined' ? selectedUrlUploadService : uploadConfig.service;
        if (service === 'custom') {
            service = (uploadConfig.customList || ["gofile.io", "buzzheavier.com"]).join(',');
        } else if (service === 'all') {
            service = ALL_WORKING_UPLOAD_SERVICES;
        } else if (!service || service === 'local') {
            service = 'gofile.io';
        }
        const reqHeaders = { 'User-Agent': navigator.userAgent };
        if (variantUrl && variantUrl !== url) {
            reqHeaders['x-fs-variant-url'] = variantUrl;
        }
        const captionInput = document.getElementById('urlUploadCaptionInput');
        let telegramCaption = '';
        if (captionInput && captionInput.closest('.telegram-caption-row') && !captionInput.closest('.telegram-caption-row').classList.contains('d-none')) {
            telegramCaption = captionInput.value.trim();
        }
        const audioOnlyCheckbox = document.getElementById('urlUploadAudioOnlyCheckbox');
        const audioOnly = audioOnlyCheckbox ? audioOnlyCheckbox.checked : false;

        if (audioOnly && fileName.toLowerCase().endsWith(".mp4")) {
            fileName = fileName.substring(0, fileName.lastIndexOf(".")) + ".m4a";
        } else if (audioOnly && !fileName.toLowerCase().endsWith(".m4a")) {
            fileName += ".m4a";
        }
        
        return { url, variantUrl, resolution, isM3u8, fileName, service, reqHeaders, telegramCaption, audioOnly };
    }

    function addDownloadTask(details, isUpload) {
    const dlId = `dl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const targetUrl = details.variantUrl || details.url;
    const dlData = {
        id: dlId,
        name: details.fileName,
        url: details.url,
        originalUrl: details.url,
        selectedUrl: details.url,
        variantUrl: details.variantUrl,
        resolution: details.resolution || null,
            action: isUpload ? "upload" : "download",
            uploadService: isUpload ? details.service : null,
            telegramCaption: details.telegramCaption || "",
            type: details.isM3u8 ? "hls" : "direct",
            audioOnly: details.audioOnly,
            preFlightConfirmed: true
        };
        chrome.storage.local.set({ [dlId]: dlData, dl_queue: dlData }, () => {
            window.location.href = "downloader.html?id=" + dlId;
        });
    }

    const urlUploadWatchBtn = document.getElementById('urlUploadWatchBtn');
    if (urlUploadWatchBtn) {
        urlUploadWatchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const details = getUrlUploadDetails();
            if (!details) return CustomDialog.show({title: 'Error', message: 'Please enter a valid URL', type: 'danger'});
            let pUrl = `player.html?url=${encodeURIComponent(details.url)}`;
            if (details.variantUrl && details.variantUrl !== details.url) {
                pUrl += `&variant=${encodeURIComponent(details.variantUrl)}`;
            }
            if (details.audioOnly) {
                pUrl += `&audioOnly=true`;
            }
            chrome.tabs.create({ url: pUrl });
        });
    }

    const urlDownloadLocalBtn = document.getElementById('urlDownloadLocalBtn');
    if (urlDownloadLocalBtn) {
        urlDownloadLocalBtn.addEventListener('click', () => {
            try {
                const details = getUrlUploadDetails();
                if (!details) return CustomDialog.show({title: 'Error', message: 'Please enter a valid URL', type: 'danger'});
                addDownloadTask(details, false);
            } catch (e) { CustomDialog.show({title: 'Invalid URL', message: 'Please enter a valid HTTP/HTTPS URL.', type: 'danger'}); }
        });
    }

    const urlUploadLocalBtn = document.getElementById('urlUploadLocalBtn');
    if (urlUploadLocalBtn) {
        urlUploadLocalBtn.addEventListener('click', () => {
            try {
                const details = getUrlUploadDetails();
                if (!details) return CustomDialog.show({title: 'Error', message: 'Please enter a valid URL', type: 'danger'});
                addDownloadTask(details, true);
            } catch (e) { CustomDialog.show({title: 'Invalid URL', message: 'Please enter a valid HTTP/HTTPS URL.', type: 'danger'}); }
        });
    }

    if (serverUploadSubmitBtn) {
        serverUploadSubmitBtn.addEventListener('click', () => {
            let url = serverUrlInput.value.trim();
            if (!url) return CustomDialog.show({title: 'Error', message: 'Please enter a valid URL', type: 'danger'});
            
            const variantsContainer = document.getElementById("urlUploadVariantsContainer");
            const variantSelect = document.getElementById("urlUploadVariantSelect");
            let resolution = null;
            let variantUrl = null;
            if (variantsContainer && !variantsContainer.classList.contains("d-none") && variantSelect && variantSelect.value) {
                variantUrl = variantSelect.value;
                resolution = variantSelect.options[variantSelect.selectedIndex]?.dataset?.resolution;
            }
            
            try {
                const parsed = new URL(url);
                const isM3u8 = parsed.pathname.toLowerCase().endsWith('.m3u8');
                let fileName = serverUrlFileNameInput.value.trim();
                if (fileName && serverUrlFileNameInput.dataset.ext) {
                    fileName += serverUrlFileNameInput.dataset.ext;
                }
                if (!fileName) {
                    const pathParts = parsed.pathname.split('/');
                    fileName = pathParts.pop() || (isM3u8 ? 'stream.mp4' : 'download.mp4');
                    if (isM3u8 && fileName.endsWith('.m3u8')) fileName = fileName.replace('.m3u8', '.mp4');
                }

                let service = selectedUrlUploadService;
                if (service === 'custom') {
                    service = (uploadConfig.customList || ["gofile.io", "buzzheavier.com"]).join(',');
                } else if (service === 'all') {
                    service = ALL_WORKING_UPLOAD_SERVICES;
                } else if (!service || service === 'local') {
                    service = 'gofile.io';
                }
                const reqHeaders = { 'User-Agent': navigator.userAgent };
                if (variantUrl && variantUrl !== url) {
                    reqHeaders['x-fs-variant-url'] = variantUrl;
                }

                const captionInput = document.getElementById('urlUploadCaptionInput');
                let telegramCaption = '';
                if (captionInput && captionInput.closest('.telegram-caption-row') && !captionInput.closest('.telegram-caption-row').classList.contains('d-none')) {
                    telegramCaption = captionInput.value.trim();
                }

                const payloadCreds = { ...(uploadConfig.credentials || {}) };
                if (telegramCaption) {
                    payloadCreds.caption = telegramCaption;
                    payloadCreds.telegram = { ...(payloadCreds.telegram || {}), caption: telegramCaption };
                }

                const audioOnlyCheckbox = document.getElementById('urlUploadAudioOnlyCheckbox');
                const audioOnly = audioOnlyCheckbox ? audioOnlyCheckbox.checked : false;

                if (audioOnly && fileName.toLowerCase().endsWith(".mp4")) {
                    fileName = fileName.substring(0, fileName.lastIndexOf(".")) + ".m4a";
                } else if (audioOnly && !fileName.toLowerCase().endsWith(".m4a")) {
                    fileName += ".m4a";
                }

                chrome.runtime.sendMessage({
                    action: 'ACTION_START_SERVER_UPLOAD',
                    payload: {
                        url: url,
                        type: isM3u8 ? 'hls' : 'direct',
                        fileName: fileName,
                        headers: reqHeaders,
                        service: service,
                        resolution: resolution,
                        credentials: payloadCreds,
                        telegramCaption: telegramCaption,
                        audioOnly: audioOnly
                    }
                }, (response) => {
                    if (chrome.runtime.lastError || (response && !response.success)) {
                        CustomDialog.show({title: 'Server Upload Failed', message: chrome.runtime.lastError?.message || response?.error || 'Unknown error', type: 'danger'});
                    } else {
                        serverUrlInput.value = '';
                        serverUrlFileNameInput.value = '';
                        serverUrlFileNameInput.dataset.ext = '';
                        if (serverUrlFileNameInput.parentNode.classList.contains("input-group")) {
                            serverUrlFileNameInput.parentNode.style.display = 'none';
                        } else {
                            serverUrlFileNameInput.style.display = 'none';
                        }
                        window.location.href = "downloader.html";
                    }
                });
            } catch (e) {
                CustomDialog.show({title: 'Invalid URL', message: 'Please enter a valid HTTP/HTTPS URL.', type: 'danger'});
            }
        });
    }

    selectFilesBtn.addEventListener('click', () => fileInput.click());
    selectFolderBtn.addEventListener('click', () => folderInput.click());
    dropZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') fileInput.click();
    });

    fileInput.addEventListener('change', function() {
        if (this.files.length) {
            handleFileList(Array.from(this.files));
        }
        this.value = '';
    });

    folderInput.addEventListener('change', async function() {
        if (this.files.length) {
            await handleFolderFiles(Array.from(this.files));
        }
        this.value = '';
    });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    ['dragenter', 'dragover'].forEach(name => {
        dropZone.addEventListener(name, () => dropZone.classList.add('dragover'));
    });

    ['dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, () => dropZone.classList.remove('dragover'));
    });

    dropZone.addEventListener('drop', async (e) => {
        const items = e.dataTransfer.items;
        if (items && items.length > 0) {
            const files = [];
            const folderEntries = [];

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.webkitGetAsEntry) {
                    const entry = item.webkitGetAsEntry();
                    if (entry) {
                        if (entry.isDirectory) {
                            folderEntries.push(entry);
                        } else {
                            const file = item.getAsFile();
                            if (file) files.push(file);
                        }
                    }
                } else {
                    const file = item.getAsFile();
                    if (file) files.push(file);
                }
            }

            if (files.length) handleFileList(files);

            for (const folder of folderEntries) {
                await processDirectoryEntry(folder);
            }
        } else if (e.dataTransfer.files.length) {
            handleFileList(Array.from(e.dataTransfer.files));
        }
    });

        function handleFileList(files) {
        try {
            files.forEach(file => {
                addQueueItem(file, file.name, file.size, false);
            });
            updateUI();
            if (isUploading) {
                window.triggerQueueProcess();
            }
        } catch(e) {
            CustomDialog.show({ title: 'Upload Error', message: e.message, type: 'danger' });
            console.error(e);
        }
    }

    // Handle folder files from <input webkitdirectory>
    async function handleFolderFiles(fileArray) {
        try {
            if (!fileArray.length) return;
            
            // Find folder name from webkitRelativePath
            const firstPath = fileArray[0].webkitRelativePath || '';
            const folderName = firstPath.split('/')[0] || 'folder';

            const totalSize = fileArray.reduce((acc, f) => acc + (f.size || 0), 0);
            if (totalSize > 500 * 1024 * 1024) {
                const proceed = await confirmLargeFolder(folderName, totalSize);
                if (!proceed) {
                    return;
                }
            }

            showZipNotice(`Folder detected: "${folderName}" (${formatBytes(totalSize)}). Packaging into "${folderName}.zip"...`);

            currentZipAbortController = new AbortController(); let zip = new ZipBuilder(); let zipCompleted = false; try { let processedBytes = 0; for (const f of fileArray) { const relativePath = f.webkitRelativePath || f.name; const startingProcessed = processedBytes; const success = await zip.addFile(relativePath, f, (bytesWritten) => { const totalProcessed = startingProcessed + bytesWritten; const percent = (totalProcessed / totalSize) * 100; updateZipNoticeProgress(percent); }, currentZipAbortController.signal); if (success === false) { throw "Cancelled by user"; } processedBytes += (f.size || 0); }

            const zipBlob = await zip.generateBlob();
            hideZipNotice();

            const zipFile = new File([zipBlob], `${folderName}.zip`, { type: 'application/zip' });
            zipFile.dispose = async () => { if (zip && typeof zip.dispose === 'function') { await zip.dispose(); } };
            addQueueItem(zipFile, zipFile.name, zipFile.size, true); zipCompleted = true; updateUI(); if (isUploading) window.triggerQueueProcess(); } finally { if (zip && !zipCompleted) { zip.dispose(); } } } catch(e) { if (e !== 'Cancelled by user' && e.message !== 'Cancelled by user') { CustomDialog.show({ title: 'Folder Upload Error', message: e.message || e, type: 'danger' }); } } finally { hideZipNotice(); currentZipAbortController = null; updateUI(); }
    }

    // Process drag & dropped directory entry
    async function processDirectoryEntry(dirEntry) {
        const folderName = dirEntry.name || 'folder';

        try {
            const files = [];
            async function scan(entry, currentPath = '') {
                if (entry.isFile) {
                    const file = await new Promise((res, rej) => entry.file(res, rej));
                    files.push({ path: currentPath + entry.name, file });
                } else if (entry.isDirectory) {
                    const reader = entry.createReader();
                    const readEntries = () => new Promise((res, rej) => reader.readEntries(res, rej));
                    let batch;
                    do {
                        batch = await readEntries();
                        for (const child of batch) {
                            await scan(child, currentPath + entry.name + '/');
                        }
                    } while (batch.length > 0);
                }
            }

            await scan(dirEntry);

            const totalSize = files.reduce((acc, item) => acc + (item.file.size || 0), 0);
            if (totalSize > 100 * 1024 * 1024) {
                const proceed = await confirmLargeFolder(folderName, totalSize);
                if (!proceed) {
                    return;
                }
            }

            showZipNotice(`Folder detected: "${folderName}" (${formatBytes(totalSize)}). Packaging into "${folderName}.zip"...`);

            currentZipAbortController = new AbortController(); let zip = new ZipBuilder(); let zipCompleted = false; try { let processedBytes = 0; for (const item of files) { const startingProcessed = processedBytes; const success = await zip.addFile(item.path, item.file, (bytesWritten) => { const totalProcessed = startingProcessed + bytesWritten; const percent = (totalProcessed / totalSize) * 100; updateZipNoticeProgress(percent); }, currentZipAbortController.signal); if (success === false) { throw "Cancelled by user"; } processedBytes += (item.file.size || 0); }
            const zipBlob = await zip.generateBlob();
            const zipFile = new File([zipBlob], `${folderName}.zip`, { type: 'application/zip' });
            zipFile.dispose = async () => { if (zip && typeof zip.dispose === 'function') { await zip.dispose(); } };
            addQueueItem(zipFile, zipFile.name, zipFile.size, true); zipCompleted = true; } finally { if (zip && !zipCompleted) { zip.dispose(); } } } catch(err) {
            if (err !== 'Cancelled by user' && err.message !== 'Cancelled by user') {
                console.error('Folder packing error:', err);
                await CustomDialog.alert(`Error packaging folder "${folderName}": ${err.message || err}`);
            }
        } finally {
            hideZipNotice();
            currentZipAbortController = null;
            updateUI();
        }
    }

    function updateZipNoticeProgress(percent) {
        const pBar = document.getElementById('zipNoticeProgressBar');
        if (pBar) pBar.style.width = percent + '%';
    }

    function showZipNotice(msg) {
        zipNoticeText.textContent = msg;
        zipNotice.classList.remove('d-none');
    }

    function hideZipNotice() { zipNotice.classList.add('d-none'); updateZipNoticeProgress(0); }

    // Add item to queue
    function addQueueItem(file, displayName, size, isZipFolder = false) {
        const id = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const item = {
            id,
            file,
            name: displayName,
            size: size,
            isZipFolder,
            service: uploadConfig.service,
            status: 'pending',
            progress: 0,
            speed: '',
            uploadedBytes: 0,
            totalBytes: size,
            url: null,
            links: [],
            error: null,
            xhr: null,
            el: null
        };

        item.el = createQueueElement(item);
        fileQueue.push(item);
        queueList.appendChild(item.el);
    }

    function createQueueElement(item) {
        const div = document.createElement('div');
        div.className = 'queue-card';
        div.id = item.id;

        const currentSvc = manualServiceMode?.checked ? (item.service || '') : (item.service || uploadConfig.service || serviceSelect.value || 'all');
        item.service = currentSvc;

        const folderTag = item.isZipFolder ? '<span class="badge bg-info text-dark me-1"><i class="bi bi-folder-symlink me-1"></i>ZIP Folder</span>' : '';

        div.innerHTML = `
            <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                <div class="overflow-hidden flex-grow-1">
                    <div class="d-flex align-items-center gap-1 text-truncate mb-1">
                        ${folderTag}
                        <strong class="text-dark text-truncate item-title"></strong>
                    </div>
                    <div class="d-flex align-items-center gap-1.5 flex-wrap">
                        <span class="text-muted small">${formatBytes(item.size)} • Service:</span>
                        <select class="form-select form-select-sm item-service-select py-0 px-2 fw-semibold text-primary" style="width: auto; font-size: 0.75rem; height: 24px; border-color: #cbd5e1;" title="Choose upload service for this item">
                            ${window.getServiceOptionsHtml(item.service)}
                        </select>
                    </div>
                </div>
                <div class="d-flex align-items-center gap-1 flex-shrink-0">
                    <span class="badge bg-secondary font-monospace status-badge" style="font-size: 0.7rem;">PENDING</span>
                    <button class="btn btn-sm btn-outline-primary py-0 px-2 retry-btn d-none" title="Retry Upload" style="font-size: 0.75rem;"><i class="bi bi-arrow-clockwise me-1"></i>Retry</button>
                    <button class="btn btn-sm btn-outline-warning py-0 px-2 pause-btn d-none" title="Pause" style="font-size: 0.75rem;"><i class="bi bi-pause-fill"></i></button>
                    <button class="btn btn-sm btn-outline-success py-0 px-2 resume-btn d-none" title="Resume" style="font-size: 0.75rem;"><i class="bi bi-play-fill"></i></button>
                    <button class="btn btn-sm btn-outline-danger py-0 px-2 cancel-btn d-none" title="Cancel Upload" style="font-size: 0.75rem;"><i class="bi bi-x"></i> Cancel</button>
                    <button class="btn btn-sm btn-outline-danger py-0 px-2 clear-btn" title="Clear / Remove this upload" style="font-size: 0.75rem;"><i class="bi bi-trash"></i></button>
                </div>
            </div>

            <div class="progress mb-2" style="height: 8px; border-radius: 4px; background-color: #e2e8f0;">
                <div class="progress-bar item-progress-bar" role="progressbar" style="width: 0%; transition: width 0.15s ease;"></div>
            </div>

            <div class="d-flex justify-content-between align-items-center small text-muted font-monospace" style="font-size: 0.75rem;">
                <span class="item-stats">Ready to upload</span>
                <span class="item-speed"></span>
            </div>

            <div class="item-caption-container mt-2 ${serviceIncludesTelegram(item.service, item.customList || uploadConfig.customList) ? '' : 'd-none'}">
                <div class="input-group input-group-sm">
                    <span class="input-group-text bg-light text-info py-0 px-2" style="font-size: 0.72rem; border-color: #cbd5e1;">
                        <i class="bi bi-telegram me-1"></i> Caption
                    </span>
                    <input type="text" class="form-control form-control-sm item-caption-input py-0.5 px-2" placeholder="Telegram description / caption (optional)" style="font-size: 0.75rem; border-color: #cbd5e1;" spellcheck="false">
                </div>
            </div>

            <div class="result-container mt-2 pt-2 border-top d-none"></div>
        `;

        const captionInput = div.querySelector('.item-caption-input');
        if (captionInput) {
            captionInput.value = item.telegramCaption || '';
        }

        const titleEl = div.querySelector('.item-title');
        if (titleEl) {
            titleEl.textContent = item.name;
            titleEl.setAttribute('title', item.name);
        }

        const serviceSelectEl = div.querySelector('.item-service-select');
        const captionContainer = div.querySelector('.item-caption-container');
        const captionInputEl = div.querySelector('.item-caption-input');

        if (captionInputEl) {
            captionInputEl.oninput = () => {
                item.telegramCaption = captionInputEl.value;
            };
        }

        if (serviceSelectEl) {
            serviceSelectEl.onchange = (e) => {
                item.service = e.target.value;
                item.customServiceSet = true;
                if (item.service === 'custom') {
                    window.openMultiHostModal('item', item.customList || uploadConfig.customList, (selectedList) => {
                        item.customList = selectedList;
                        updateItemUI(item);
                    });
                }
                if (captionContainer) {
                    if (serviceIncludesTelegram(item.service, item.customList || uploadConfig.customList)) {
                        captionContainer.classList.remove('d-none');
                    } else {
                        captionContainer.classList.add('d-none');
                    }
                }
            };
        }

        const pauseBtn = div.querySelector('.pause-btn');
        const resumeBtn = div.querySelector('.resume-btn');
        const retryBtn = div.querySelector('.retry-btn');
        const cancelBtn = div.querySelector('.cancel-btn');
        const clearBtn = div.querySelector('.clear-btn');

        pauseBtn.onclick = () => pauseItem(item);
        resumeBtn.onclick = () => resumeItem(item);
        retryBtn.onclick = () => retryItem(item);
        cancelBtn.onclick = () => cancelItem(item);
        clearBtn.onclick = () => clearItem(item);

        return div;
    }

    function updateItemUI(item) {
        if (!item.el) return;
        const el = item.el;
        const badge = el.querySelector('.status-badge');
        const bar = el.querySelector('.item-progress-bar');
        const stats = el.querySelector('.item-stats');
        const speed = el.querySelector('.item-speed');
        const pauseBtn = el.querySelector('.pause-btn');
        const resumeBtn = el.querySelector('.resume-btn');
        const retryBtn = el.querySelector('.retry-btn');
        const cancelBtn = el.querySelector('.cancel-btn');
        const clearBtn = el.querySelector('.clear-btn');
        const resultContainer = el.querySelector('.result-container');

        bar.style.width = `${item.progress}%`;

        if (item.status === 'uploading') {
            badge.textContent = 'UPLOADING';
            badge.className = 'badge bg-primary font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar progress-bar-striped progress-bar-animated bg-primary';
            stats.textContent = `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.totalBytes)} (${item.progress}%)`;
            speed.textContent = item.speed || '';
            pauseBtn.classList.remove('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.add('d-none');
            cancelBtn.classList.remove('d-none');
            clearBtn.classList.add('d-none');
        } else if (item.status === 'paused') {
            badge.textContent = 'PAUSED';
            badge.className = 'badge bg-warning text-dark font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar bg-warning';
            stats.textContent = `Paused at ${item.progress}%`;
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.remove('d-none');
            retryBtn.classList.add('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');
        } else if (item.status === 'success') {
            badge.textContent = 'COMPLETED';
            badge.className = 'badge bg-success font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar bg-success';
            bar.style.width = '100%';
            stats.innerHTML = '<span class="text-success fw-bold">✓ Upload Complete</span>';
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.add('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');

            // Render result link(s)
            renderResultLinks(item, resultContainer);
        } else if (item.status === 'error') {
            badge.textContent = 'FAILED';
            badge.className = 'badge bg-danger font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar bg-danger';
            stats.innerHTML = '<span class="text-danger fw-semibold err-txt"></span>';
            stats.querySelector('.err-txt').textContent = item.error || 'Upload error';
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.remove('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');
        } else if (item.status === 'cancelled') {
            badge.textContent = 'CANCELLED';
            badge.className = 'badge bg-secondary font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar bg-secondary';
            stats.textContent = 'Upload cancelled';
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.remove('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');
        } else if (item.status === 'pending') {
            badge.textContent = 'PENDING';
            badge.className = 'badge bg-secondary font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar';
            stats.textContent = 'Ready to upload';
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.add('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');
        }

        const serviceSelectEl = el.querySelector('.item-service-select');
        if (serviceSelectEl) {
            serviceSelectEl.disabled = (item.status === 'uploading' || item.status === 'success');
        }
    }

    function renderResultLinks(item, container) {
        container.classList.remove('d-none');

        if (item.links && item.links.length > 0) {
            container.innerHTML = `
                <span class="small fw-semibold text-muted d-block mb-1">Generated Links (${item.links.length} Services):</span>
                <div class="d-flex flex-column gap-1 result-links-list"></div>
            `;
            const listDiv = container.querySelector('.result-links-list');
            item.links.forEach(l => {
                const box = document.createElement('div');
                box.className = "multi-link-box d-flex justify-content-between align-items-center gap-2";
                box.innerHTML = `
                    <div class="overflow-hidden text-truncate">
                        <strong class="text-dark srv-name"></strong>:
                        <a target="_blank" class="text-decoration-none text-primary ms-1 srv-link"></a>
                    </div>
                    <button class="btn btn-xs btn-outline-secondary copy-link-btn flex-shrink-0" style="font-size: 0.72rem; padding: 2px 6px;">
                        <i class="bi bi-clipboard"></i> Copy
                    </button>
                `;
                box.querySelector('.srv-name').textContent = l.service;
                const aEl = box.querySelector('.srv-link');
                aEl.href = isSafeHttpUrl(l.url) ? l.url : '#';
                aEl.textContent = l.url;
                aEl.title = l.url;
                const btn = box.querySelector('.copy-link-btn');
                btn.setAttribute('data-url', l.url);
                listDiv.appendChild(box);
            });
        } else if (item.url) {
            const isLink = isSafeHttpUrl(item.url);
            container.innerHTML = `
                <div class="d-flex justify-content-between align-items-center gap-2">
                    <span class="text-truncate small text-muted font-monospace srv-single-url" style="font-size: 0.78rem;"></span>
                    <div class="d-flex gap-1 flex-shrink-0 single-actions"></div>
                </div>
            `;
            const spanUrl = container.querySelector('.srv-single-url');
            spanUrl.textContent = item.url;
            spanUrl.title = item.url;
            
            const actionsDiv = container.querySelector('.single-actions');
            if (isLink) {
                const aOpen = document.createElement('a');
                aOpen.href = item.url;
                aOpen.target = "_blank";
                aOpen.className = "btn btn-sm btn-outline-primary py-0 px-2";
                aOpen.style.fontSize = "0.75rem";
                aOpen.innerHTML = '<i class="bi bi-box-arrow-up-right"></i> Open';
                actionsDiv.appendChild(aOpen);
            }
            const btnCopy = document.createElement('button');
            btnCopy.className = "btn btn-sm btn-outline-secondary py-0 px-2 copy-single-btn";
            btnCopy.style.fontSize = "0.75rem";
            btnCopy.setAttribute('data-url', item.url);
            btnCopy.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
            actionsDiv.appendChild(btnCopy);
        }

        const copySingle = container.querySelector('.copy-single-btn');
        if (copySingle) {
            copySingle.onclick = () => {
                navigator.clipboard.writeText(copySingle.getAttribute('data-url')).then(() => {
                    copySingle.innerHTML = '<i class="bi bi-check2"></i> Copied';
                    setTimeout(() => copySingle.innerHTML = '<i class="bi bi-clipboard"></i> Copy', 1500);
                });
            };
        }

        const multiCopies = container.querySelectorAll('.copy-link-btn');
        multiCopies.forEach(btn => {
            btn.onclick = () => {
                navigator.clipboard.writeText(btn.getAttribute('data-url')).then(() => {
                    btn.innerHTML = '<i class="bi bi-check2"></i> Copied';
                    setTimeout(() => btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy', 1500);
                });
            };
        });
    }

    function updateSummary() {
        const total = fileQueue.length;
        queueCount.textContent = total;

        if (total === 0) {
            emptyQueue.classList.remove('d-none');
            summaryDiv.classList.add('d-none');
            return;
        }

        emptyQueue.classList.add('d-none');
        summaryDiv.classList.remove('d-none');

        const completed = fileQueue.filter(i => i.status === 'success').length;
        const overall = Math.round((completed / total) * 100);

        summaryText.textContent = `${completed} of ${total} files uploaded`;
        summaryPercent.textContent = `${overall}%`;
        summaryProgress.style.width = `${overall}%`;
    }

    function updateUI() {
        const pendingCount = fileQueue.filter(i => i.status === 'pending' || i.status === 'paused').length;
        const missingManualService = manualServiceMode?.checked && fileQueue.some(i =>
            (i.status === 'pending' || i.status === 'paused') && !i.service
        );
        startUploadBtn.disabled = isUploading || pendingCount === 0 || missingManualService;
        pauseAllBtn.disabled = !isUploading;
        cancelAllBtn.disabled = fileQueue.length === 0;
        clearQueueBtn.disabled = isUploading || fileQueue.length === 0;
        updateSummary();
    }

    // Queue processing
        const MAX_CONCURRENCY = 4;
    let activeUploadCount = 0;

    window.triggerQueueProcess = async () => {
        if (isQueuePaused) return;

        const processNext = async () => {
            if (isQueuePaused) return;
            if (activeUploadCount >= MAX_CONCURRENCY) return;

            const nextItem = fileQueue.find(i => (i.status === 'pending' || i.status === 'paused') && !i.isProcessing);
            if (!nextItem) return;

            nextItem.isProcessing = true;
            activeUploadCount++;
            updateUI();

            try {
                await uploadItem(nextItem);
            } finally {
                activeUploadCount--;
                nextItem.isProcessing = false;
                updateSummary();
                processNext();

                if (activeUploadCount === 0) {
                    const hasPending = fileQueue.some(i => (i.status === 'pending' || i.status === 'paused') && !i.isProcessing);
                    if (!hasPending && !isQueuePaused) {
                        isUploading = false;
                        updateUI();
                    }
                }
            }
        };

        for(let i = activeUploadCount; i < MAX_CONCURRENCY; i++) {
            processNext();
        }
    };

    startUploadBtn.addEventListener('click', () => {
        if (isUploading) return;
        if (manualServiceMode?.checked && fileQueue.some(i =>
            (i.status === 'pending' || i.status === 'paused') && !i.service
        )) {
            CustomDialog.alert('Choose an upload service for every queued item before starting.', 'Upload Destination Required', 'warning');
            return;
        }
        isQueuePaused = false;
        isUploading = true;
        updateUI();
        window.triggerQueueProcess();
    });
    pauseAllBtn.addEventListener('click', () => {
        isQueuePaused = true;
        if (currentActiveItem && currentActiveItem.status === 'uploading') {
            pauseItem(currentActiveItem);
        }
        isUploading = false;
        updateUI();
    });

    cancelAllBtn.addEventListener('click', () => {
        isQueuePaused = true;
        if (currentActiveItem && currentActiveItem.status === 'uploading') {
            cancelItem(currentActiveItem);
        }
        fileQueue.forEach(item => {
            if (item.status === 'pending' || item.status === 'paused') {
                item.status = 'cancelled';
                updateItemUI(item);
            }
        });
        isUploading = false;
        updateUI();
    });

    clearQueueBtn.addEventListener('click', () => {
        if (isUploading) return;
        fileQueue.forEach(item => {
            if (typeof item.file?.dispose === 'function') {
                item.file.dispose();
            }
        });
        fileQueue = [];
        queueList.innerHTML = '';
        updateUI();
    });

    function pauseItem(item) {
        if (item.abortController) {
            try { item.abortController.abort(); } catch(e) {}
        }
        if (item.xhr) {
            try { item.xhr.abort(); } catch(e) {}
            item.xhr = null;
        }
        item.status = 'paused';
        isQueuePaused = true;
        updateItemUI(item);
        updateUI();

        try {
            chrome.runtime.sendMessage({
                cmd: 'UPDATE_UPLOAD_PROGRESS',
                parameter: {
                    id: item.id,
                    progress: item.progress,
                    speed: 'Paused',
                    state: 'paused'
                }
            });
        } catch(e) {}
    }

    function resumeItem(item) {
        item.status = 'pending';
        item.abortController = new AbortController();
        isQueuePaused = false;
        updateItemUI(item);
        updateUI();
        if (!isUploading) {
            startUploadBtn.click();
        }
    }

    function cancelItem(item) {
        if (item.abortController) {
            try { item.abortController.abort(); } catch(e) {}
        }
        if (item.xhr) {
            try { item.xhr.abort(); } catch(e) {}
            item.xhr = null;
        }
        item.status = 'cancelled';
        updateItemUI(item);

        try {
            chrome.runtime.sendMessage({
                cmd: 'UPLOAD_FINISHED',
                parameter: { id: item.id }
            });
        } catch(e) {}

        updateUI();
    }

    function clearItem(item) {
        if (item.status === 'uploading') {
            cancelItem(item);
        }
        if (typeof item.file?.dispose === 'function') {
            item.file.dispose();
        }
        if (item.el) {
            item.el.remove();
        }
        fileQueue = fileQueue.filter(i => i.id !== item.id);
        updateUI();
    }

    function retryItem(item) {
        item.status = 'pending';
        item.progress = 0;
        item.uploadedBytes = 0;
        item.speed = '';
        item.error = null;
        item.url = null;
        item.links = [];
        item.abortController = new AbortController();
        isQueuePaused = false;

        const resultContainer = item.el?.querySelector('.result-container');
        if (resultContainer) {
            resultContainer.innerHTML = '';
            resultContainer.classList.add('d-none');
        }

        updateItemUI(item);
        updateUI();

        if (!isUploading) {
            startUploadBtn.click();
        }
    }

    window.getServiceOptionsHtml = function(selectedVal) {
        const services = [
            { value: '', label: 'Choose a service...' },
            { value: 'all', label: 'All Working Services' },
            { value: 'custom', label: 'Custom Multi-Host List' },
            { value: 'gofile.io', label: 'GoFile' },
            { value: 'buzzheavier.com', label: 'Buzzheavier' },
            { value: 'fuckingfast.co', label: 'FuckingFast' },
            { value: 'storage.to', label: 'Storage.to' },
            { value: 'catbox.moe', label: 'Catbox.moe' },
            { value: 'pixeldrain.com', label: 'Pixeldrain' },
            { value: 's3_compatible', label: 'S3-Compatible Storage' },
            { value: 'telegram', label: 'Telegram Bot' }
        ];
        return services.map(s => '<option value="' + s.value + '" ' + (s.value === selectedVal ? 'selected' : '') + '>' + s.label + '</option>').join('');
    }
    
    async function confirmLargeFolder(folderName, totalBytes) {
        const sizeStr = formatBytes(totalBytes);
        const modalEl = document.getElementById('largeFolderModal');
        if (modalEl && typeof bootstrap !== 'undefined' && bootstrap.Modal) {
            const nameEl = document.getElementById('largeFolderName');
            const sizeEl = document.getElementById('largeFolderSize');
            if (nameEl) nameEl.textContent = folderName;
            if (sizeEl) sizeEl.textContent = sizeStr;
            const bsModal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
            
            return new Promise(resolve => {
                const cancelBtn = document.getElementById('cancelLargeFolderBtn');
                const proceedBtn = document.getElementById('proceedLargeFolderBtn');
                
                const cleanup = () => {
                    cancelBtn.onclick = null;
                    proceedBtn.onclick = null;
                    bsModal.hide();
                };
                
                cancelBtn.onclick = () => {
                    cleanup();
                    resolve(false);
                };
                
                proceedBtn.onclick = () => {
                    cleanup();
                    resolve(true);
                };
                
                bsModal.show();
            });
        }
        return confirm('The selected folder ' + folderName + ' is ' + sizeStr + ' in size.\n\nWhile FetchStream uses advanced Origin Private File System streaming to prevent browser crashes and reduce RAM usage, zipping very large folders directly in the browser may still take a few moments.\n\nIf you prefer, you can cancel and compress this folder into a .zip file on your computer first, then upload that directly.\n\nDo you want to proceed with in-browser zipping?');
    }
    async function confirmPreFlightModal(fileName, sizeBytes, service) {
        if (typeof ServiceLimits === 'undefined') {
            return { proceed: true, service };
        }

        const report = ServiceLimits.check(sizeBytes, service, uploadConfig, false);
        if (!report.hasWarnings) {
            return { proceed: true, service };
        }

        const modalEl = document.getElementById('preFlightModal');
        if (!modalEl || typeof bootstrap === 'undefined' || !bootstrap.Modal) {
            return { proceed: true, service };
        }

        const fileNameEl = document.getElementById('preFlightFileName');
        const fileSizeEl = document.getElementById('preFlightFileSize');
        const warningsContainer = document.getElementById('preFlightWarningsContainer');
        const runnerNotice = document.getElementById('preFlightRunnerNotice');
        const safeContainer = document.getElementById('preFlightSafeContainer');
        const safeText = document.getElementById('preFlightSafeText');
        const skipBtn = document.getElementById('preFlightSkipBtn');
        const proceedBtn = document.getElementById('preFlightProceedBtn');
        const cancelBtn = document.getElementById('preFlightCancelBtn');

        if (fileNameEl) fileNameEl.textContent = fileName || 'File';
        if (fileSizeEl) fileSizeEl.textContent = report.formattedSize;

        if (warningsContainer) {
            warningsContainer.innerHTML = report.problematic.map(p => `
                <div class="alert alert-warning py-1.5 px-2.5 small mb-0 border-warning" style="font-size: 0.74rem; line-height: 1.35;">
                    <div class="d-flex align-items-center gap-1.5 fw-bold text-dark mb-0.5">
                        <i class="bi bi-exclamation-triangle-fill text-warning"></i>
                        <span>${window.escapeHTML(String(p.name))} (Limit: ${window.escapeHTML(String(p.limitStr))})</span>
                    </div>
                    <div class="text-muted">${window.escapeHTML(String(p.reason))}</div>
                </div>
            `).join('');
        }

        if (safeContainer && safeText) {
            if (report.safe.length > 0 && report.problematic.length > 0) {
                safeContainer.classList.remove('d-none');
                safeText.textContent = `Compatible: ${report.safe.map(s => s.name).join(', ')} (fits within limits).`;
            } else {
                safeContainer.classList.add('d-none');
            }
        }

        if (skipBtn) {
            skipBtn.classList.toggle('d-none', !report.canSkipIncompatible);
        }

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

        return new Promise((resolve) => {
            let resolved = false;

            const cleanup = () => {
                modalEl.removeEventListener('hidden.bs.modal', onHidden);
                if (proceedBtn) proceedBtn.removeEventListener('click', onProceed);
                if (skipBtn) skipBtn.removeEventListener('click', onSkip);
                if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
            };

            const onProceed = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    resolve({ proceed: true, service });
                }
            };

            const onSkip = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    const filtered = report.safe.map(s => s.service).join(',');
                    resolve({ proceed: true, service: filtered });
                }
            };

            const onCancel = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    resolve({ proceed: false, service: null });
                }
            };

            const onHidden = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve({ proceed: false, service: null });
                }
            };

            if (proceedBtn) proceedBtn.addEventListener('click', onProceed, { once: true });
            if (skipBtn) skipBtn.addEventListener('click', onSkip, { once: true });
            if (cancelBtn) cancelBtn.addEventListener('click', onCancel, { once: true });
            modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });

            modal.show();
        });
    }

    // Execute upload for single item
    async function uploadItem(item) {
        const targetService = item.service || uploadConfig.service || serviceSelect.value || 'all';
        if (!targetService) {
            item.status = 'error';
            item.error = 'Choose an upload destination first.';
            updateItemUI(item);
            return;
        }
        const preFlight = await confirmPreFlightModal(item.name || item.file?.name, item.file?.size || item.size || 0, targetService);
        if (!preFlight.proceed || !preFlight.service) {
            item.status = 'cancelled';
            item.error = 'Cancelled by user';
            updateItemUI(item);
            return;
        }

        item.service = preFlight.service;
        item.status = 'uploading';
        item.abortController = new AbortController();
        
        // Buffer standard files in OPFS when available.
        if (!item.isZipFolder && !item.isBuffered && item.file && typeof item.file.stream === 'function') {
            updateItemUI(item);
            const stats = item.el.querySelector('.item-stats');
            if(stats) stats.innerHTML = '<span class="text-info fw-bold"><i class="bi bi-lightning-charge-fill me-1"></i>Preparing...</span>';
            
            try {
                const root = await navigator.storage.getDirectory();
                const safeName = 'fs_turbo_' + Date.now() + '_' + (item.file.name || 'file').replace(/[^a-zA-Z0-9.-]/g, '_');
                const fileHandle = await root.getFileHandle(safeName, { create: true });
                const writable = await fileHandle.createWritable();
                
                await item.file.stream().pipeTo(writable, { signal: item.abortController.signal });
                
                const opfsFile = await fileHandle.getFile();
                // Replace the OS file handle with the OPFS file handle for better performance
                item.file = opfsFile;
                item.isBuffered = true;
                
                item.file.dispose = async () => {
                    try { await root.removeEntry(safeName); } catch(e){}
                };
            } catch(e) {
                if (e.name === 'AbortError') {
                    item.status = 'cancelled';
                    updateItemUI(item);
                    return;
                }
                console.warn("Turbo buffer failed, falling back to standard OS read", e);
            }
        }

        updateItemUI(item);

        // Notify service worker
        try {
            chrome.runtime.sendMessage({
                cmd: 'REGISTER_UPLOAD',
                parameter: {
                    id: item.id,
                    name: item.name,
                    service: item.service,
                    size: item.size
                }
            });
        } catch(e) {}

        let lastTime = Date.now();
        let lastLoaded = 0;

        const resultContainer = item.el.querySelector('.result-container');

        let finalService = item.service; if (finalService === "custom") { finalService = (uploadConfig.customList || ["gofile.io", "buzzheavier.com"]).join(","); } const activeUploadConfig = { service: finalService,
            credentials: { ...(uploadConfig.credentials || {}) },
            signal: item.abortController.signal,
            _xhrCallback: (xhr) => {
                item.xhr = xhr;
            },
            onLinkGenerated: (linkObj) => {
                if (!item.links) item.links = [];
                if (!item.links.some(l => l.serviceId === linkObj.serviceId)) {
                    item.links.push(linkObj);
                }
                if (resultContainer) {
                    renderResultLinks(item, resultContainer);
                }
            }
        };

        if (item.telegramCaption) {
            activeUploadConfig.credentials.caption = item.telegramCaption;
            activeUploadConfig.credentials.telegram = {
                ...(activeUploadConfig.credentials.telegram || {}),
                caption: item.telegramCaption
            };
        }

        try {
            const result = await FetchStreamUploader.upload(item.file, item.name, activeUploadConfig, (loadedOrEvt, totalParam) => {
                let loaded = 0, total = item.size || 1;
                if (typeof loadedOrEvt === 'object' && loadedOrEvt !== null) {
                    loaded = loadedOrEvt.loaded || 0;
                    total = (loadedOrEvt.lengthComputable && loadedOrEvt.total > 0) ? loadedOrEvt.total : (item.size || 1);
                } else {
                    loaded = Number(loadedOrEvt) || 0;
                    total = Number(totalParam) > 0 ? Number(totalParam) : (item.size || 1);
                }

                const now = Date.now();
                const diffSec = (now - lastTime) / 1000;
                if (diffSec >= 0.4) {
                    const bytesDiff = loaded - lastLoaded;
                    const spd = bytesDiff / diffSec;
                    item.speed = `${formatBytes(spd)}/s`;
                    lastTime = now;
                    lastLoaded = loaded;
                }

                item.uploadedBytes = loaded;
                item.totalBytes = total;
                item.progress = Math.min(99, Math.round((loaded / total) * 100));

                updateItemUI(item);

                try {
                    chrome.runtime.sendMessage({
                        cmd: 'UPDATE_UPLOAD_PROGRESS',
                        parameter: {
                            id: item.id,
                            progress: item.progress,
                            speed: item.speed,
                            uploadedBytes: item.uploadedBytes,
                            totalBytes: item.totalBytes,
                            state: 'uploading'
                        }
                    });
                } catch(e) {}
            });

            // Extract URL and links properly
            let finalUrl = '';
            let multiLinks = item.links || [];
            if (typeof result === 'string') {
                finalUrl = result;
            } else if (result && typeof result === 'object') {
                finalUrl = result.url || '';
                if (Array.isArray(result.links) && result.links.length > 0) {
                    multiLinks = result.links;
                }
            }

            item.status = 'success';
            item.url = finalUrl;
            item.links = multiLinks;
            item.progress = 100;
            item.speed = '';
            if (result?.failed) {
                item.status = 'error';
                item.error = 'All uploads failed';
                updateItemUI(item);
                renderResultLinks(item, resultContainer);
                return;
            }
            item.xhr = null; updateItemUI(item); if (typeof item.file?.dispose === 'function') { try { item.file.dispose(); } catch(e){} } // Record to permanent history
            if (typeof HistoryManager !== 'undefined') {
                HistoryManager.addRecord({
                    type: 'upload',
                    name: item.name,
                    size: item.size,
                    service: item.service,
                    url: finalUrl,
                    links: multiLinks,
                    status: 'completed'
                });
            }

            try {
                chrome.runtime.sendMessage({
                    cmd: 'UPLOAD_FINISHED',
                    parameter: {
                        id: item.id,
                        url: finalUrl
                    }
                });
            } catch(e) {}

        } catch(err) {
            if (item.status === 'paused' || item.status === 'cancelled' || err.name === 'AbortError') return;
            item.status = 'error';
            item.error = err.message || 'Upload failed';
            item.xhr = null;
            updateItemUI(item);

            try {
                chrome.runtime.sendMessage({
                    cmd: 'UPLOAD_FINISHED',
                    parameter: {
                        id: item.id,
                        error: item.error
                    }
                });
            } catch(e) {}
        }
    }

    // Listen for cross-tab pause / cancel messages from popup
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.cmd === 'PAUSE_UPLOAD_REMOTE' && msg.parameter?.id) {
            const item = fileQueue.find(i => i.id === msg.parameter.id);
            if (item) pauseItem(item);
        }
        if (msg?.cmd === 'RESUME_UPLOAD_REMOTE' && msg.parameter?.id) {
            const item = fileQueue.find(i => i.id === msg.parameter.id);
            if (item) resumeItem(item);
        }
        if (msg?.cmd === 'CANCEL_UPLOAD_REMOTE' && msg.parameter?.id) {
            const item = fileQueue.find(i => i.id === msg.parameter.id);
            if (item) cancelItem(item);
        }
        if (msg?.cmd === 'PAUSE_ALL_UPLOADS_REMOTE') {
            pauseAllBtn.click();
        }
        if (msg?.cmd === 'CANCEL_ALL_UPLOADS_REMOTE') {
            cancelAllBtn.click();
        }
    });

    // forward internal HTML links to focus existing tab or open new tab without interrupting uploads
    document.querySelectorAll('a[href$=".html"]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            if (href) {
                chrome.tabs.query({ url: chrome.runtime.getURL(href) }, (tabs) => {
                    if (tabs.length > 0) {
                        chrome.tabs.update(tabs[0].id, { active: true });
                    } else {
                        chrome.tabs.create({ url: chrome.runtime.getURL(href) });
                    }
                });
            }
        });
    });

    // Warn before unloading if uploads are active or queued
    window.addEventListener('beforeunload', (e) => {
        const hasActive = isUploading || fileQueue.some(i => i.status === 'uploading' || i.status === 'queued');
        if (hasActive && hasUserGesture) {
            e.preventDefault();
            e.returnValue = 'Uploads are currently in progress or queued. Leaving will cancel them.';
            return e.returnValue;
        }
    });
        window.addEventListener('beforeunload', () => {
        // 1. Dispose active queue items
        fileQueue.forEach(item => {
            if (typeof item.file?.dispose === 'function') {
                try { item.file.dispose(); } catch(e) {}
            }
        });

        // Remove temporary OPFS files created for the upload.
        try {
            navigator.storage.getDirectory().then(root => {
                root.entries().forEach(async ([name, handle]) => {
                    if (name.startsWith('fs_zip_') || name.startsWith('fs_dl_') || name.startsWith('fs_turbo_')) {
                        await root.removeEntry(name, { recursive: true }).catch(()=>{});
                    }
                });
            }).catch(()=>{});
        } catch(e) {}
    });
});
    


    window.openMultiHostModal = function(context, currentList, onSave) {
        const modalEl = document.getElementById("multiHostModal");
        if (!modalEl) return;
        
        const container = document.getElementById("multiHostCheckboxesContainer");
        if (container) {
            const availableServices = [
                { id: "gofile.io", name: "GoFile" },
                { id: "buzzheavier.com", name: "Buzzheavier" },
                { id: "fuckingfast.co", name: "FFast" },
                { id: "storage.to", name: "Storage.to" },
                { id: "catbox.moe", name: "Catbox.moe" },
                { id: "pixeldrain.com", name: "Pixeldrain" },
                { id: "s3_compatible", name: "S3-Compatible Storage" },
                { id: "telegram", name: "Telegram Bot API" }
            ];
            
            container.innerHTML = availableServices.map(srv => {
                const isChecked = (currentList || []).includes(srv.id) ? "checked" : "";
                return '<div class="form-check form-switch mb-0"><input class="form-check-input multi-host-chk" type="checkbox" role="switch" value="' + srv.id + '" id="mh_' + srv.id + '" ' + isChecked + '><label class="form-check-label" for="mh_' + srv.id + '">' + srv.name + '</label></div>';
            }).join('');
        }
        
        const bsModal = window.bootstrap && window.bootstrap.Modal 
            ? (window.bootstrap.Modal.getInstance(modalEl) || new window.bootstrap.Modal(modalEl)) 
            : null;
            
        const saveBtn = document.getElementById("multiHostSaveBtn");
        if (saveBtn) {
            saveBtn.onclick = () => {
                const checkedBoxes = Array.from(modalEl.querySelectorAll(".multi-host-chk:checked"));
                const selectedServices = checkedBoxes.map(cb => cb.value);
                if (selectedServices.length === 0) { alert("Please select at least one destination service."); return; }
                if (bsModal) bsModal.hide();
                if (typeof onSave === "function") onSave(selectedServices);
            };
        }
        if (bsModal) bsModal.show();
    };


    window.getServiceOptionsHtml = function(selectedVal) {
        const services = [
            { value: 'all', label: 'All Working Services' },
            { value: 'custom', label: 'Custom Multi-Host List' },
            { value: 'gofile.io', label: 'GoFile' },
            { value: 'buzzheavier.com', label: 'Buzzheavier' },
            { value: 'fuckingfast.co', label: 'FuckingFast' },
            { value: 'storage.to', label: 'Storage.to' },
            { value: 'catbox.moe', label: 'Catbox.moe' },
            { value: 'pixeldrain.com', label: 'Pixeldrain' },
            { value: 's3_compatible', label: 'S3-Compatible Storage' },
            { value: 'telegram', label: 'Telegram Bot' }
        ];
        return services.map(s => '<option value="' + s.value + '" ' + (s.value === selectedVal ? 'selected' : '') + '>' + s.label + '</option>').join('');
    };




















































