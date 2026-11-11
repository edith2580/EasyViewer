#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include "bindings/bindings.h"

@interface EasyViewerThemeHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) WKWebView *webView;
@end

@implementation EasyViewerThemeHandler

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.name isEqualToString:@"easyviewer_theme"]) {
        NSString *theme = [NSString stringWithFormat:@"%@", message.body];
        dispatch_async(dispatch_get_main_queue(), ^{
            UIWindow *window = self.webView.window;
            if (!window) {
                for (UIWindow *w in [UIApplication sharedApplication].windows) {
                    if (w.isKeyWindow) { window = w; break; }
                }
            }
            
            UIColor *bgColor;
            UIUserInterfaceStyle style;
            
            if ([theme isEqualToString:@"dark"]) {
                style = UIUserInterfaceStyleDark;
                bgColor = [UIColor colorWithRed:11.0/255.0 green:15.0/255.0 blue:25.0/255.0 alpha:1.0]; // #0b0f19
            } else if ([theme isEqualToString:@"sepia"]) {
                style = UIUserInterfaceStyleLight;
                bgColor = [UIColor colorWithRed:239.0/255.0 green:228.0/255.0 blue:204.0/255.0 alpha:1.0]; // #efe4cc
            } else {
                style = UIUserInterfaceStyleLight;
                bgColor = [UIColor colorWithRed:248.0/255.0 green:250.0/255.0 blue:252.0/255.0 alpha:1.0]; // #f8fafc
            }
            
            if (@available(iOS 13.0, *)) {
                if (window) {
                    window.overrideUserInterfaceStyle = style;
                }
            }
            if (window) {
                window.backgroundColor = bgColor;
            }
            if (self.webView) {
                self.webView.backgroundColor = bgColor;
                self.webView.scrollView.backgroundColor = bgColor;
            }
            
            UIViewController *rootVC = window.rootViewController;
            if (rootVC) {
                if (@available(iOS 13.0, *)) {
                    rootVC.overrideUserInterfaceStyle = style;
                }
                rootVC.view.backgroundColor = bgColor;
                [rootVC setNeedsStatusBarAppearanceUpdate];
            }
        });
    }
}

@end

@interface WKWebView (EasyViewerSetup)
@end

@implementation WKWebView (EasyViewerSetup)

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        Class class_ = [self class];
        
        SEL origInit = @selector(initWithFrame:configuration:);
        SEL swizInit = @selector(easyviewer_initWithFrame:configuration:);
        Method mOrigInit = class_getInstanceMethod(class_, origInit);
        Method mSwizInit = class_getInstanceMethod(class_, swizInit);
        if (mOrigInit && mSwizInit) {
            method_exchangeImplementations(mOrigInit, mSwizInit);
        }
        
        SEL origMove = @selector(didMoveToWindow);
        SEL swizMove = @selector(easyviewer_didMoveToWindow);
        Method mOrigMove = class_getInstanceMethod(class_, origMove);
        Method mSwizMove = class_getInstanceMethod(class_, swizMove);
        if (mOrigMove && mSwizMove) {
            method_exchangeImplementations(mOrigMove, mSwizMove);
        }
    });
}

- (instancetype)easyviewer_initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    EasyViewerThemeHandler *handler = [[EasyViewerThemeHandler alloc] init];
    [configuration.userContentController addScriptMessageHandler:handler name:@"easyviewer_theme"];
    
    WKWebView *webView = [self easyviewer_initWithFrame:frame configuration:configuration];
    handler.webView = webView;
    return webView;
}

- (void)easyviewer_didMoveToWindow {
    [self easyviewer_didMoveToWindow];
    
    if (self.window != nil) {
        if (@available(iOS 11.0, *)) {
            self.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
        }
        self.scrollView.bounces = NO;
        
        UIColor *lightBg = [UIColor colorWithRed:248.0/255.0 green:250.0/255.0 blue:252.0/255.0 alpha:1.0];
        self.opaque = YES;
        self.backgroundColor = lightBg;
        self.scrollView.backgroundColor = lightBg;
        
        if (@available(iOS 13.0, *)) {
            self.window.overrideUserInterfaceStyle = UIUserInterfaceStyleLight;
        }
        self.window.backgroundColor = lightBg;
        
        UIViewController *rootVC = self.window.rootViewController;
        if (rootVC) {
            if (@available(iOS 13.0, *)) {
                rootVC.overrideUserInterfaceStyle = UIUserInterfaceStyleLight;
            }
            rootVC.view.backgroundColor = lightBg;
            [rootVC setNeedsStatusBarAppearanceUpdate];
        }
    }
}

@end

@interface UIViewController (EasyViewerStatusBar)
@end

@implementation UIViewController (EasyViewerStatusBar)

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        Class class_ = [self class];
        SEL origSel = @selector(preferredStatusBarStyle);
        SEL swizSel = @selector(easyviewer_preferredStatusBarStyle);
        
        Method origMethod = class_getInstanceMethod(class_, origSel);
        Method swizMethod = class_getInstanceMethod(class_, swizSel);
        if (origMethod && swizMethod) {
            if (!class_addMethod(class_, origSel, method_getImplementation(swizMethod), method_getTypeEncoding(swizMethod))) {
                method_exchangeImplementations(origMethod, swizMethod);
            }
        }
    });
}

- (UIStatusBarStyle)easyviewer_preferredStatusBarStyle {
    if (@available(iOS 13.0, *)) {
        if (self.overrideUserInterfaceStyle == UIUserInterfaceStyleDark) {
            return UIStatusBarStyleLightContent;
        } else if (self.overrideUserInterfaceStyle == UIUserInterfaceStyleLight) {
            return UIStatusBarStyleDarkContent;
        }
        if (self.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark) {
            return UIStatusBarStyleLightContent;
        } else {
            return UIStatusBarStyleDarkContent;
        }
    }
    return UIStatusBarStyleDefault;
}

@end

int main(int argc, char * argv[]) {
    @autoreleasepool {
        ffi::start_app();
    }
    return 0;
}
