$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Windows PowerShell 5.1: use the modern Shell dialog instead of the legacy tree.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KejiaFolderPicker {
    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr types);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, out IShellItem item);
    public static string Choose(string title, IntPtr owner) {
        IFileOpenDialog dialog = null;
        IShellItem start = null, result = null;
        IntPtr name = IntPtr.Zero;
        try {
            dialog = (IFileOpenDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
            uint options;
            dialog.GetOptions(out options);
            // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST | DONTADDTORECENT
            dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x02000000);
            dialog.SetTitle(title);
            // Start at This PC without probing a disconnected previous drive.
            Guid iid = typeof(IShellItem).GUID;
            SHCreateItemFromParsingName("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", IntPtr.Zero, ref iid, out start);
            dialog.SetFolder(start);
            int status = dialog.Show(owner);
            if (status == unchecked((int)0x800704C7)) return "";
            Marshal.ThrowExceptionForHR(status);
            dialog.GetResult(out result);
            result.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
            return Marshal.PtrToStringUni(name);
        } finally {
            if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
            if (result != null) Marshal.ReleaseComObject(result);
            if (start != null) Marshal.ReleaseComObject(start);
            if (dialog != null) Marshal.ReleaseComObject(dialog);
        }
    }
}
'@
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
try {
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.Opacity = 0
    $owner.Show()
    $owner.Activate()
    [Console]::Write([KejiaFolderPicker]::Choose($env:COURSE_ARCHIVE_PICKER_DESCRIPTION, $owner.Handle))
} finally { $owner.Dispose() }
