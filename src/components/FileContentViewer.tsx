import React, { useState, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StorageAssignment, FileMetadata } from '../types';
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FolderIcon, FileIcon, FileTextIcon, FileCodeIcon, FileImageIcon, DownloadIcon, ShareIcon, X, Check, CheckCircleIcon, ExternalLinkIcon, Loader2 } from 'lucide-react';
import { Placement, useArFleet } from '../contexts/ArFleetContext';
import { ArpReader } from '@/helpers/arp';
import { DataItemReader, reassembleDataItemForArweave } from '@/helpers/dataitemmod';
import { AESContainerReader } from '@/helpers/aes';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { b64UrlToBuffer, b64UrlToString, bufferTob64, bufferTob64Url, stringToB64Url } from '@/helpers/encodeUtils';
import { encKeyFromMasterKeyAndSalt } from '@/helpers/encrypt';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { bufferToAscii } from '@/helpers/buf';
import { downloadUint8ArrayAsFile } from '@/helpers/extra';
import { DataItem } from "@dha-team/arbundles";
import { ARFLEET_VERSION } from '@/helpers/version';
import mime from 'mime';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogAction } from "@/components/ui/alert-dialog";

interface FileTreeItem {
  type: 'file' | 'folder';
  name: string;
  path: string;
  children?: FileTreeItem[];
  file?: FileMetadata;
}

export default function FileContentViewer() {
  const { assignments, selectedAssignmentId, masterKey, wallet } = useArFleet();
  const assignment = assignments.find((a: StorageAssignment) => a.id === selectedAssignmentId);
  const [isLoading, setIsLoading] = useState(true);

  const [isDownloading, setIsDownloading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [hoveredFolder, setHoveredFolder] = useState<string | null>(null);
  const [downloadingFilePath, setDownloadingFilePath] = useState<string | null>(null);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [shareItem, setShareItem] = useState<FileTreeItem | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [isImmortalizeDialogOpen, setIsImmortalizeDialogOpen] = useState(false);
  const [immortalizeItem, setImmortalizeItem] = useState<FileTreeItem | null>(null);
  const [immortalizeType, setImmortalizeType] = useState<'encrypted' | 'decrypted'>('encrypted');
  const [isImmortalizing, setIsImmortalizing] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ id: string; url: string } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const pickPlacement = (assignment: StorageAssignment) => {
    const filterOnlyCompleted = assignment.placements.filter((p: Placement) => p.status === 'completed');
    if (filterOnlyCompleted.length > 0) {
      return filterOnlyCompleted[0];
    } else {
      return assignment.placements[0];
    }
  };

  useEffect(() => {
    if (assignment) {
      setIsLoading(assignment.files.length === 0);
    }
  }, [assignment]);

  useEffect(() => {
    if (isShareDialogOpen && shareItem && masterKey) {
      const getShareUrl = async () => {
        try {
          const placement = pickPlacement(assignment);
          const url = await deriveShareUrl(shareItem, placement, masterKey);
          setShareUrl(url);
        } catch (error) {
          console.error('Error generating share URL:', error);
          setShareUrl(null);
        }
      };
      getShareUrl();
    }
  }, [isShareDialogOpen, shareItem, masterKey, assignment]);

  const deriveShareUrl = async (shareItem: FileTreeItem, placement: Placement, masterKey: Uint8Array) => {
    const placementProviderUrl = placement.provider;
    const key = await deriveKey(masterKey, shareItem.file!, placement);
    const keyB64 = bufferTob64Url(key);
    const encodedName = stringToB64Url(shareItem.file!.name);
    return `${window.location.origin}/#/download/${shareItem.file!.arpId}/${keyB64}/${encodedName}/${encodeURIComponent(placementProviderUrl)}`;
  };

  const deriveKey = async (masterKey: Uint8Array, file: FileMetadata, placement: Placement) => {
    let arpId = file.arpId;
    if (!arpId) {
      if (file.arp) {
        arpId = file.arp.chunkHashes[0];
      } else {
        throw new Error('ARP Id is not set');
      }
    }

    const arpReader = new ArpReader(arpId, placement);
    await arpReader.init();

    const dataItemReader = new DataItemReader(arpReader);
    await dataItemReader.init();

    const aesReader = new AESContainerReader(dataItemReader, masterKey);
    await aesReader.init();

    const salt = aesReader.salt;
    const key = await encKeyFromMasterKeyAndSalt(masterKey, salt);

    return key;
  };

  const handleCopyUrl = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  if (!assignment) {
    return null;
  }

  const buildFileTree = (files: FileMetadata[]): FileTreeItem[] => {
    const root: FileTreeItem = { type: 'folder', name: '/', path: '/', children: [] };
    
    files.forEach(file => {
      const parts = file.path.split('/').filter(Boolean);
      let currentLevel = root;

      parts.forEach((part, index) => {
        if (index === parts.length - 1) {
          currentLevel.children?.push({
            type: 'file',
            name: part,
            path: file.path,
            file: file
          });
        } else {
          let folder = currentLevel.children?.find(item => item.type === 'folder' && item.name === part);
          if (!folder) {
            folder = { type: 'folder', name: part, path: '/' + parts.slice(0, index + 1).join('/'), children: [] };
            currentLevel.children?.push(folder);
          }
          currentLevel = folder;
        }
      });
    });

    return root.children || [];
  };

  const getFileIcon = (fileName: string) => {
    const extension = fileName.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'txt':
      case 'md':
        return <FileTextIcon className="w-full h-full text-blue-500" />;
      case 'js':
      case 'ts':
      case 'py':
      case 'html':
      case 'css':
        return <FileCodeIcon className="w-full h-full text-green-500" />;
      case 'jpg':
      case 'png':
      case 'gif':
      case 'svg':
        return <FileImageIcon className="w-full h-full text-purple-500" />;
      default:
        return <FileIcon className="w-full h-full text-gray-500" />;
    }
  };

  const isDescendantOfHoveredFolder = (path: string) => {
    if (!hoveredFolder) return false;
    return path.startsWith(hoveredFolder + '/');
  };

  const openShareDialog = (item: FileTreeItem) => {
    setShareItem(item);
    setIsShareDialogOpen(true);
  };

  const closeShareDialog = () => {
    setIsShareDialogOpen(false);
    setShareItem(null);
    setShareUrl(null);
  };

  const openImmortalizeDialog = (item: FileTreeItem) => {
    setImmortalizeItem(item);
    setIsImmortalizeDialogOpen(true);
  };

  const closeImmortalizeDialog = () => {
    setIsImmortalizeDialogOpen(false);
    setImmortalizeItem(null);
    setUploadResult(null);
  };

  const handleImmortalizeSubmit = async () => {
    setIsImmortalizing(true);
    try {
      // decrypted vs encrypted
      const dataItemType = immortalizeType === 'encrypted' ? 'encrypted' : 'decrypted';

      console.log(`Immortalizing ${dataItemType} data for ${immortalizeItem?.path}`);

      let dataItemContents: Uint8Array;

      const arpReader = new ArpReader(immortalizeItem?.file?.arpId, pickPlacement(assignment));
      await arpReader.init();
  
      if (dataItemType === 'encrypted') {
        // upload encrypted data item
        // dataItemContents = await arpReader.slice(0, arpReader.innerByteLength);

        const dataItemReader = new DataItemReader(arpReader);
        await dataItemReader.init();

        dataItemContents = await dataItemReader.slice(0, await dataItemReader.dataLength);
      } else {
        const dataItemReader = new DataItemReader(arpReader);
        await dataItemReader.init();
  
        // upload decrypted data item
        if (!masterKey) throw new Error('Master key is not set');
        const aesReader = new AESContainerReader(dataItemReader, masterKey);
        await aesReader.init();

        const dataItemReader2 = new DataItemReader(aesReader);
        await dataItemReader2.init();

        dataItemContents = await dataItemReader2.slice(0, dataItemReader2.dataLength);
      }

      // const assembledDataItem = await reassembleDataItemForArweave(dataItemContents);

      // console.log('assembledDataItem', bufferToAscii(assembledDataItem));

      console.log('dataItemContents', bufferToAscii(dataItemContents));

      const uploadingFileName = (dataItemType === 'encrypted') ? immortalizeItem?.file?.arpId + '.aes' : immortalizeItem?.file?.name;

      // Determine the Content-Type using mime-types
      const contentType = mime.getType(uploadingFileName || '') || 'application/octet-stream';

      // Create a random 32-character string

const tosign = {
  data: dataItemContents,
  tags: [
    {name: "ArFleet-Client", value: "Web"},
    {name: "ArFleet-Version", value: ARFLEET_VERSION},
    {
      name: "ArFleet-DataItem-Type",
      value: (dataItemType === 'encrypted') ? "aes" : "file"
    },
    {
      name: "ArFleet-DataItem-Path",
      value: immortalizeItem?.file?.path
    },
    {
      name: "name",
      value: uploadingFileName
    },
    {
      name: "Content-Type",
      value: contentType
    }
],
anchor: "0"

};
console.log('tosign', tosign);
      
      // Sign the data item with the correct Content-Type
      const signed = await wallet.signDataItem(tosign);

      console.log('signed', signed);


      ////////
      // Send to Arweave
      ///////

      // const file = downloadUint8ArrayAsFile(assembledDataItem, 'dataitem.dat');

      // load the result into a DataItem instance
      const signedDataItem = new DataItem(signed);
      
      console.log('signedDataItem', signedDataItem);

      // Add this code to output hex
      const rawBytes = new Uint8Array(signedDataItem.getRaw());  // Convert Buffer to Uint8Array
      console.log('Data Item Hex:', Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join(''));
      
      const result = await fetch(`https://up.arweave.net/tx/arweave`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/json'
        },
        body: signedDataItem.getRaw()
      });

      if (result.ok) {
        console.log('Data item uploaded successfully');

        const resp = await result.json();
        const txId = resp.id;
        console.log('id', txId);
        
        // Set the upload result
        setUploadResult({
          id: txId,
          url: `https://arweave.net/${txId}`
        });
      } else {
        console.error('Failed to upload data item');
        // You might want to show an error message to the user here
      }

      console.log('result', result);

      // fetch(
      //   `https://${HOST}/tx/arweave`,
      //   {
      //     method: 'POST',
      //     headers: {
      //       'Content-Type': 'application/octet-stream',
      //       Accept: 'application/json'
      //     },
      //     body: await sign({ data, tags, target, anchor })
      //       .then((dataItem) => dataItem.getRaw())
      //   }
      // )
  
    } catch (error) {
      console.error('Error immortalizing file:', error);
      throw error;
      // You might want to show an error message to the user here
    } finally {
      setIsImmortalizing(false);
      // Don't close the dialog here, as we want to show the result
    }
  };

  const renderFileTree = (items: FileTreeItem[], depth = 0) => {
    return items.map((item) => (
      <li
        key={item.path}
        className={`${depth > 0 ? 'ml-4' : ''}`}
        onMouseEnter={() => item.type === 'folder' && setHoveredFolder(item.path)}
        onMouseLeave={() => setHoveredFolder(null)}
      >
        <div className={`grid grid-cols-[auto_1fr_auto] gap-2 items-center py-2 px-2 group text-sm rounded-md
          ${hoveredFolder === item.path ? 'bg-gray-200 dark:bg-gray-700' : ''}
          ${isDescendantOfHoveredFolder(item.path) ? 'bg-gray-100 dark:bg-gray-800' : ''}
          ${item.type === 'file' ? 'hover:bg-gray-100 dark:hover:bg-gray-800' : ''}`}
        >
          <Checkbox
            className={`${selectedItems.has(item.path) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} h-4 w-4`}
            checked={selectedItems.has(item.path)}
            onCheckedChange={(checked) => {
              const newSelected = new Set(selectedItems);
              if (checked) {
                newSelected.add(item.path);
              } else {
                newSelected.delete(item.path);
              }
              setSelectedItems(newSelected);
            }}
          />
          <div className="flex items-center min-w-0">
            <div className="flex-shrink-0 w-5 h-5 mr-2">
              {item.type === 'folder' ? (
                <FolderIcon className="w-full h-full text-yellow-500" />
              ) : (
                getFileIcon(item.name)
              )}
            </div>
            <span className="truncate" title={item.name}>
              {item.name}
            </span>
          </div>
          {item.type === 'file' && item.file?.arpId && isPlacementCompleted() && (
            <div className="flex flex-wrap gap-2 items-center justify-end invisible group-hover:visible">
              <Button
                size="sm"
                variant="outline"
                onClick={() => item.file && downloadFile(item.file)}
                disabled={downloadingFilePath === item.path}
                className="p-1 h-7 bg-white dark:bg-gray-800 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors duration-200 text-black dark:text-white border-gray-300 dark:border-gray-600"
              >
                <DownloadIcon className="w-4 h-4 mr-1" />
                {downloadingFilePath === item.path ? 'Downloading...' : 'Download'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openShareDialog(item)}
                className="p-1 h-7 bg-white dark:bg-gray-800 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors duration-200 text-black dark:text-white border-gray-300 dark:border-gray-600"
              >
                <ShareIcon className="w-4 h-4 mr-1" />
                Share
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openImmortalizeDialog(item)}
                className="p-1 h-7 bg-white dark:bg-gray-800 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors duration-200 text-black dark:text-white border-gray-300 dark:border-gray-600"
              >
                <span className="w-4 h-4 mr-1 inline-flex items-center justify-center border border-current rounded-full text-xs">
                  <span className="relative bottom-[1px]">a</span>
                </span>
                Immortalize
              </Button>
            </div>
          )}
        </div>
        {item.type === 'folder' && item.children && (
          <ul className="mt-1">
            {renderFileTree(item.children, depth + 1)}
          </ul>
        )}
      </li>
    ));
  };

  const isPlacementCompleted = () => {
    const placement = pickPlacement(assignment);
    return placement.status === 'completed';
  };

  const fileTree = buildFileTree(assignment.files);

  const downloadFile = async (file: FileMetadata) => {
    console.log('Downloading file:', file);
    setDownloadingFilePath(file.path);
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const placement = pickPlacement(assignment);
      
      if (!masterKey) {
        console.error('Master key is not set');
        return;
      }

      console.log({file})

      let arpId = file.arpId;
      if (!arpId) {
        if (file.arp) {
          arpId = file.arp.chunkHashes[0];
          console.log('arpId', arpId);
        } else {
          throw new Error('ARP Id is not set');
        }
      }

      const arpReader = new ArpReader(arpId, placement);
      await arpReader.init();
      console.log('arpReader', arpReader);

      const dataItemReader = new DataItemReader(arpReader);
      await dataItemReader.init();
      console.log('dataItemReader', dataItemReader);

      const aesReader = new AESContainerReader(dataItemReader, masterKey);
      await aesReader.init();
      console.log('aesReader', aesReader);

      const decryptedDataItemReader = new DataItemReader(aesReader);
      await decryptedDataItemReader.init();
      console.log('decryptedDataItemReader', decryptedDataItemReader);
      
      const fileData = await decryptedDataItemReader.slice(0, decryptedDataItemReader.dataLength);
      
      const blob = new Blob([fileData], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setIsDownloading(false);
      setDownloadingFilePath(null);
    } catch (error) {
      console.error('Error downloading file:', error);
      setDownloadError("We couldn't download the file. If the placement just finished, please wait a few minutes and try again, as the provider may still be decrypting RSA chunks.");
      setIsDownloading(false);
    } finally {
      setIsDownloading(false);
    }
  };

  for (const file of assignment.files) {
    if (!file.arpId) {
      if (file.arp?.chunkHashes && Object.keys(file.arp.chunkHashes).length > 0) {
        file.arpId = file.arp.chunkHashes[0];
      }
    }
  }

  return (
    <div className="p-2 border-t">
      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="files">
          {isLoading ? (
            <div className="flex items-center justify-center p-4">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <span>Loading files...</span>
            </div>
          ) : (
            <div className="overflow-y-auto">
              <ul className="mt-1">
                {renderFileTree(fileTree)}
              </ul>
            </div>
          )}
        </TabsContent>
      </Tabs>
      <Dialog open={isShareDialogOpen} onOpenChange={closeShareDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">Share file</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col space-y-4">
            <p className="text-sm text-muted-foreground">
              Copy the URL below to share this file.
            </p>
            <div>
              <p className="text-sm font-medium">Name/Path:</p>
              <p className="text-sm text-muted-foreground">{shareItem?.path}</p>
            </div>
            <div>
              <p className="text-sm font-medium">URL:</p>
              {shareUrl ? (
                <p 
                  className="text-sm text-muted-foreground break-all cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 p-1 rounded transition-colors duration-200"
                  onClick={handleCopyUrl}
                  title="Click to copy"
                >
                  {shareUrl}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Generating URL...</p>
              )}
            </div>
          </div>
          <Button
            onClick={handleCopyUrl}
            className="w-full mt-4"
            disabled={!shareUrl || isCopied}
          >
            {isCopied ? (
              <>
                <Check className="mr-2 h-4 w-4" /> Copied
              </>
            ) : (
              'Copy URL'
            )}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={isImmortalizeDialogOpen} onOpenChange={closeImmortalizeDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">
              {uploadResult ? 'File Immortalized Successfully' : 'Immortalize on Arweave'}
            </DialogTitle>
          </DialogHeader>
          {uploadResult ? (
            <div className="flex flex-col space-y-4">
              <Alert className="bg-green-50 border-green-200 dark:bg-green-900/30 dark:border-green-900">
                <CheckCircleIcon className="h-5 w-5 text-green-600 dark:text-green-400" />
                <AlertTitle className="text-green-800 dark:text-green-200">Success!</AlertTitle>
                <AlertDescription className="text-green-700 dark:text-green-300">
                  Your file has been successfully immortalized on Arweave.
                </AlertDescription>
              </Alert>
              <div>
                <Label className="text-sm font-medium">Transaction ID:</Label>
                <Input value={uploadResult.id} readOnly className="mt-1 bg-gray-50 dark:bg-gray-800" />
              </div>
              <div>
                <Label className="text-sm font-medium">Arweave URL:</Label>
                <Input value={uploadResult.url} readOnly className="mt-1 bg-gray-50 dark:bg-gray-800" />
              </div>
              <div className="flex justify-end space-x-2 pt-4">
                <Button 
                  onClick={() => window.open(uploadResult.url, '_blank')}
                  className="bg-blue-500 hover:bg-blue-600 text-white"
                >
                  <ExternalLinkIcon className="mr-2 h-4 w-4" />
                  View on Arweave
                </Button>
                <Button 
                  onClick={() => {
                    closeImmortalizeDialog();
                    setUploadResult(null);
                  }}
                  variant="outline"
                >
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col space-y-4">
                <p className="text-sm text-muted-foreground">
                  Move this file from temporary ArFleet to permanent Arweave storage:
                </p>
                <div>
                  <p className="text-sm font-medium">Name/Path:</p>
                  <p className="text-sm text-muted-foreground">{immortalizeItem?.path}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">ARP ID:</p>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Input
                          className="text-sm text-muted-foreground truncate"
                          value={immortalizeItem?.file?.arpId || ''}
                          disabled
                          title={immortalizeItem?.file?.arpId}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="bottom" align="start" className="max-w-xs">
                        <p className="text-xs break-all">{immortalizeItem?.file?.arpId}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Separator className="my-4" />
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="immortalize-type" className="text-sm font-medium">Choose data to immortalize:</Label>
                    <div className="flex items-center justify-between mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
                      <span className={`text-sm ${immortalizeType === 'encrypted' ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                        Encrypted
                      </span>
                      <Switch
                        checked={immortalizeType === 'decrypted'}
                        onCheckedChange={(checked) => setImmortalizeType(checked ? 'decrypted' : 'encrypted')}
                        disabled={isImmortalizing}
                        className="data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-blue-500"
                      />
                      <span className={`text-sm ${immortalizeType === 'decrypted' ? 'text-green-600 dark:text-green-400 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                        Decrypted
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {immortalizeType === 'encrypted' 
                      ? "Store the encrypted data on Arweave. You'll need the decryption key to access the content later."
                      : "Store the decrypted data on Arweave. The content will be publicly accessible."}
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={closeImmortalizeDialog} variant="outline" disabled={isImmortalizing}>Cancel</Button>
                <Button onClick={handleImmortalizeSubmit} disabled={isImmortalizing}>
                  {isImmortalizing ? 'Immortalizing...' : 'Proceed'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!downloadError} onOpenChange={() => setDownloadError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Download Error</AlertDialogTitle>
            <AlertDialogDescription>{downloadError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}