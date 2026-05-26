using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class WxVisualSearchLauncher
{
    [STAThread]
    private static void Main()
    {
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        string electron = Path.Combine(appDir, "node_modules", "electron", "dist", "electron.exe");

        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "没有找到 Electron 运行文件，请先在程序目录运行 npm install。",
                "WX 透视工具",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = electron,
            Arguments = Quote(appDir),
            WorkingDirectory = appDir,
            UseShellExecute = false
        };

        Process.Start(startInfo);
    }

    private static string Quote(string value)
    {
        return "\"" + value.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + "\"";
    }
}
