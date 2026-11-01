// File: tests/NugetPackageManager.Core.Tests/ExceptionTypesTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// The three failure types cross the RPC boundary, so every constructor is part of their
// contract: the code travels to the host, the message is only for logs.

using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace;
using NugetPackageManager.Core.NuGet;

namespace NugetPackageManager.Core.Tests;

[TestClass]
public class ExceptionTypesTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public void RpcException_CarriesItsCode()
    {
        var plain = new RpcException("code", "message");
        var wrapped = new RpcException("code", "message", new InvalidOperationException("inner"));
        var bare = new RpcException();

        Assert.AreEqual("code", plain.Code);
        Assert.AreEqual("message", plain.Message);
        Assert.AreEqual("code", wrapped.Code);
        Assert.IsInstanceOfType<InvalidOperationException>(wrapped.InnerException);
        Assert.AreEqual("internalError", bare.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void WorkspaceException_CarriesItsCode()
    {
        var plain = new WorkspaceException("writeFailed", "message");
        var wrapped = new WorkspaceException("writeFailed", "message", new IOException("inner"));
        var bare = new WorkspaceException();

        Assert.AreEqual("writeFailed", plain.Code);
        Assert.AreEqual("writeFailed", wrapped.Code);
        Assert.IsInstanceOfType<IOException>(wrapped.InnerException);
        Assert.AreEqual("workspaceError", bare.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void NuGetSourceException_CarriesItsCode()
    {
        var plain = new NuGetSourceException("packageNotFound", "message");
        var wrapped = new NuGetSourceException("packageNotFound", "message", new HttpRequestException("inner"));
        var bare = new NuGetSourceException();

        Assert.AreEqual("packageNotFound", plain.Code);
        Assert.AreEqual("packageNotFound", wrapped.Code);
        Assert.IsInstanceOfType<HttpRequestException>(wrapped.InnerException);
        Assert.AreEqual("sourceUnreachable", bare.Code);
    }
}
